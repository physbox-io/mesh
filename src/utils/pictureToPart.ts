// Picture to part: build, look, criticise, fix, keep what helped.
//
// HOW A ROUND GOES
//
// 1. The BUILDER (the copilot's model with the scene prompt) builds the part
//    from the photos, or, after the first round, revises it from the critic's
//    list. It also guesses which way the first photo was taken.
// 2. The part's own triangles are rasterised from every direction and the one
//    whose outline best overlaps the photo's is taken (utils/silhouette.ts);
//    the viewport is turned to it and a frame captured.
// 3. The CRITIC is a separate call that never sees the builder's reasoning,
//    only the photo and that frame, and is told to find what differs. A model
//    asked to check its own work tends to pass it.
// 4. The overlap (IoU of the two outlines) is the score that can only go up
//    or down. A round that lowers it is undone, and the builder is told so.
//    With no usable outline in the photo (a busy background), the critic's
//    own 0-10 rating stands in.
// 5. Written overall sizes are checked against the part's bounding box, a
//    hard check the critic cannot see.
//
// The loop stops when the critic finds nothing, the score stops improving
// for two rounds, the round limit is reached, or the user stops it. What is
// left over is reported, not hidden: a photo cannot show the back, the
// insides or a wall's thickness.
//
// Everything that touches the app comes in through `deps`, so the loop runs
// in a test with a scripted model and no browser.

import type { LlmImage, LlmResult } from './llmCall';
import type { RawNode } from './sceneNodes';
import { extractJSON, parseAIResponse, type DiagnosticQuestion } from './copilotReply';
import { bestView, type Mask, type View, type ViewMatch } from './silhouette';

export interface PartLoopDeps {
  llm(system: string, user: string, images: LlmImage[]): Promise<LlmResult>;
  /** Make these nodes the part (replacing the last attempt) and wait for it to compile. */
  apply(nodes: RawNode[]): Promise<{ ok: boolean; error?: string }>;
  /** The part as it stands, for the builder to revise. */
  partNodes(): RawNode[];
  /** World triangles of the part, metres, nine numbers each. */
  partTriangles(): ArrayLike<number>;
  /** The viewport turned to look from `view`, as a picture for the critic. */
  render(view: View): Promise<LlmImage | null>;
  /** The photo-direction search; silhouette.bestView unless given (the app runs it on a worker). */
  bestView?(tris: ArrayLike<number>, photo: Mask, near?: View): Promise<ViewMatch | null>;
  onProgress?(p: LoopProgress): void;
  signal?: AbortSignal;
}

export interface LoopOptions {
  /** What the user asked for, if anything beyond the picture. */
  request: string;
  photos: LlmImage[];
  /** The first photo's outline, normalised (silhouette.normalizeMask), or null when it has none worth trusting. */
  photoMask: Mask | null;
  /** The copilot's scene prompt, for the builder. */
  sceneSystem: string;
  maxRounds?: number;
}

export interface RoundReport {
  round: number;
  /** 0-1: outline overlap, or the critic's rating / 10 when there is no outline. */
  score: number;
  scoreKind: 'overlap' | 'critic';
  view: View;
  differences: string[];
  /** Undone because it scored worse than the best before it. */
  rolledBack: boolean;
  /** The builder's revision did not build at all; the kept part stands. */
  failed?: boolean;
  render: LlmImage | null;
  note?: string;
}

export interface LoopProgress {
  round: number;
  maxRounds: number;
  stage: 'building' | 'matching view' | 'critic' | 'revising' | 'done';
  rounds: RoundReport[];
}

export interface LoopReport {
  rounds: RoundReport[];
  /** The round whose part is in the scene at the end. */
  bestRound: number;
  /** What the critic still saw on the kept part. */
  remaining: string[];
  stoppedBecause: 'matched' | 'no improvement' | 'round limit' | 'stopped' | 'failed';
  error?: string;
  /** A part was built but stopped before it was ever checked: it is in the scene, unscored. */
  unchecked?: boolean;
  /** What the builder said about the kept part: sizes it assumed, what it could not see. */
  builderNotes?: string;
  questions?: DiagnosticQuestion[];
  noteCardMarkdown?: string | null;
}

export const DEFAULT_LOOP_ROUNDS = 5;
/** A round has to beat the best by more than this to count as better, and lose more than it to be undone. */
const SCORE_EPS = 0.02;

const BUILDER_RULES = `
═══════════════════════════════════════════
PICTURE TO PART
═══════════════════════════════════════════
You are building a real part to match the attached photo(s), at real size. Follow 9i (pictures).
First a short markdown summary: what you built, every size you ASSUMED rather than read (wall thickness, depth, anything hidden), and anything the photo could not show. Then ONE json block:
{"nodes": [...], "view": {"azimuthDeg": A, "elevationDeg": E}, "overallMm": [x, y, z] | null, "questions": [...] (optional), "noteCardMarkdown": "..." (optional)}
- nodes: the whole part, preferably one SCAD body with every size a top-level variable. Rest it on the floor: its lowest point at z = 0, centred on x = y = 0.
- view: the direction the FIRST photo was taken from. azimuthDeg round the vertical: 0 = from the part's front (camera on -Y), 90 = from +X (its right), 180 = from behind. elevationDeg: 0 = level, 90 = straight down. Lay the part so its front faces -Y.
- overallMm: the overall size along world X, Y, Z ONLY if the picture states it (written or with a scale reference); otherwise null.
On a revision you get the current nodes, the photos, a render of your part from the first photo's direction, and an inspector's list of differences. Fix them, keep what already matches, and return the whole part again the same way.`;

const CRITIC_SYSTEM = `You are an inspector. The FIRST picture is a photo of a real object. The SECOND is a render of a CAD model meant to copy it, seen from about the same direction. You did not build the model; your job is to find where it is wrong.
List every visible difference in shape, proportion and features: holes, slots, bosses, ribs, fillets, chamfers, steps, lettering, parts missing or extra. Most important first, one sentence each, saying what to change and by roughly how much ("the handle is about a third longer in the photo", "the photo has two mounting holes, the model one").
Ignore colour, material, lighting, shadows, background, the floor grid and perspective distortion.
Reply ONLY with: \`\`\`json {"differences": ["..."], "match": N} \`\`\` where match is 0-10 for how well the model's visible shape matches. An empty list means it matches in everything you can see.`;

/** Below this overlap on the first round the photo's outline is not of this part (a cluttered desk): the critic scores instead. */
const TRUST_OVERLAP = 0.5;

/**
 * The JSON objects in a reply, fenced or not. extractJSON alone tries the
 * outermost [...] before {...}, so an unfenced {"differences": [...]} came
 * back as its inner array and the critic never parsed.
 */
function jsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const take = (v: unknown) => { if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>); };
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) take(extractJSON(m[1]));
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { take(JSON.parse(text.slice(a, b + 1))); } catch { /* not one object */ }
  }
  return out;
}

interface Build {
  nodes: RawNode[] | null;
  view?: View;
  overallMm?: [number, number, number];
  notes: string;
  questions: DiagnosticQuestion[];
  noteCardMarkdown: string | null;
}

function parseBuild(text: string): Build {
  const { nodes: fenced, markdown, questions, noteCardMarkdown } = parseAIResponse(text);
  let nodes = fenced;
  let view: View | undefined;
  let overallMm: [number, number, number] | undefined;
  for (const j of jsonObjects(text)) {
    if (!nodes && Array.isArray(j.nodes)) nodes = j.nodes as RawNode[];
    const v = j.view as Record<string, unknown> | undefined;
    if (!view && v && Number.isFinite(Number(v.azimuthDeg)) && Number.isFinite(Number(v.elevationDeg))) {
      view = { azimuthDeg: ((Number(v.azimuthDeg) % 360) + 360) % 360, elevationDeg: Math.max(0, Math.min(90, Number(v.elevationDeg))) };
    }
    const o = j.overallMm;
    if (!overallMm && Array.isArray(o) && o.length === 3 && o.every((x) => Number(x) > 0)) {
      overallMm = o.map(Number) as [number, number, number];
    }
  }
  return { nodes, view, overallMm, notes: markdown.trim(), questions, noteCardMarkdown };
}

function parseCritic(text: string): { differences: string[]; match: number } | null {
  const j = jsonObjects(text).find((o) => Array.isArray(o.differences));
  if (!j) return null;
  const differences = (j.differences as unknown[]).map((d) => String(d).trim()).filter(Boolean);
  const match = Math.max(0, Math.min(10, Number(j.match) || 0));
  return { differences, match };
}

/** World bounding size of triangles in metres, as mm along X, Y, Z. */
export function sizeMm(tris: ArrayLike<number>): [number, number, number] | null {
  if (tris.length < 9) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tris[i + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  return [0, 1, 2].map((a) => (hi[a] - lo[a]) * 1000) as [number, number, number];
}

/** Written overall sizes the part misses by more than 2%, as sentences for the builder. */
export function sizeDifferences(actual: [number, number, number] | null, wanted?: [number, number, number]): string[] {
  if (!actual || !wanted) return [];
  const axes = ['X', 'Y', 'Z'];
  const out: string[] = [];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(actual[a] - wanted[a]) > Math.max(0.5, wanted[a] * 0.02)) {
      out.push(`Measured: the part is ${actual[a].toFixed(1)} mm along ${axes[a]}, the picture says ${wanted[a]} mm.`);
    }
  }
  return out;
}

export async function runPictureToPart(opts: LoopOptions, deps: PartLoopDeps): Promise<LoopReport> {
  const maxRounds = Math.max(1, opts.maxRounds ?? DEFAULT_LOOP_ROUNDS);
  const rounds: RoundReport[] = [];
  const builderSystem = `${opts.sceneSystem}\n${BUILDER_RULES}`;
  const aborted = () => !!deps.signal?.aborted;
  const progress = (round: number, stage: LoopProgress['stage']) =>
    deps.onProgress?.({ round, maxRounds, stage, rounds: [...rounds] });
  const searchView = deps.bestView ?? (async (t: ArrayLike<number>, m: Mask, n?: View) => bestView(t, m, n));
  const request = opts.request || 'Build the part shown in the picture.';

  let photoMask = opts.photoMask;
  let best: {
    round: number; score: number; nodes: RawNode[]; differences: string[]; render: LlmImage | null; view: View; build: Build;
  } | null = null;
  /** Whether what is in the scene now is `best`'s part. */
  let sceneIsBest = true;
  let builtUnchecked: Build | null = null;
  let guess: View | undefined;
  let overallMm: [number, number, number] | undefined;
  let feedback = '';
  let stale = 0;

  const finish = async (stoppedBecause: LoopReport['stoppedBecause'], error?: string): Promise<LoopReport> => {
    // Whatever is in the scene at the end is the round the report names.
    if (best && !sceneIsBest) {
      await deps.apply(best.nodes);
      sceneIsBest = true;
    }
    if (best) await deps.render(best.view).catch(() => null);
    progress(rounds.length, 'done');
    const kept = best?.build ?? builtUnchecked;
    return {
      rounds,
      bestRound: best?.round ?? 0,
      remaining: best?.differences ?? [],
      stoppedBecause,
      ...(error ? { error } : {}),
      ...(!best && builtUnchecked ? { unchecked: true } : {}),
      ...(kept?.notes ? { builderNotes: kept.notes } : {}),
      ...(kept?.questions.length ? { questions: kept.questions } : {}),
      ...(kept ? { noteCardMarkdown: kept.noteCardMarkdown } : {}),
    };
  };

  for (let round = 1; round <= maxRounds; round++) {
    if (aborted()) return finish('stopped');

    // Build or revise.
    progress(round, round === 1 ? 'building' : 'revising');
    const shown = round === 1 || !best?.render ? opts.photos : [...opts.photos, best.render];
    const label = shown.length > opts.photos.length
      ? `PICTURES: the first ${opts.photos.length} ${opts.photos.length === 1 ? 'is the photo' : 'are photos'}; the last is your part from the first photo's direction.`
      : `PICTURES: ${opts.photos.length === 1 ? 'the photo' : `${opts.photos.length} photos`} only.`;
    const user = round === 1
      ? request
      : `${label}\n\nCURRENT PART NODES:\n${JSON.stringify(deps.partNodes())}\n\nINSPECTOR'S DIFFERENCES (photo vs your part):\n${feedback}\n\nOriginal request: ${request}`;
    let built: Build | null = null;
    let applyError = '';
    for (let attempt = 0; attempt < 2 && !built; attempt++) {
      let reply: LlmResult;
      try {
        reply = await deps.llm(builderSystem, attempt ? `${user}\n\nYOUR LAST REPLY FAILED: ${applyError} Return the whole part again.` : user, shown);
      } catch (e) {
        if (aborted()) return finish('stopped');
        return finish('failed', (e as Error)?.message || String(e));
      }
      if (aborted()) return finish('stopped');
      const parsed = parseBuild(reply.text);
      if (!parsed.nodes?.length) {
        applyError = reply.truncated ? 'The reply was cut off at the token limit before the nodes were complete.' : 'It had no "nodes" JSON.';
        continue;
      }
      const res = await deps.apply(parsed.nodes);
      sceneIsBest = false;
      if (!res.ok) {
        applyError = res.error || 'The part did not build.';
        continue;
      }
      built = parsed;
      if (!best) builtUnchecked = parsed;
    }
    if (!built) {
      if (best) {
        rounds.push({
          round, score: best.score, scoreKind: photoMask ? 'overlap' : 'critic', view: best.view, differences: [],
          rolledBack: false, failed: true, render: null,
          note: `The revision did not build (${applyError}), so round ${best.round}'s part stands.`,
        });
      }
      return finish('failed', applyError);
    }
    guess = built.view ?? guess;
    overallMm = built.overallMm ?? overallMm;
    if (aborted()) return finish('stopped');

    // Find the photo's direction and look from it.
    progress(round, 'matching view');
    const tris = deps.partTriangles();
    let view: View = guess ?? { azimuthDeg: 30, elevationDeg: 25 };
    let overlap: number | null = null;
    let note: string | undefined;
    if (photoMask) {
      const m = await searchView(tris, photoMask, guess).catch(() => null);
      if (aborted()) return finish('stopped');
      if (m && round === 1 && m.iou < TRUST_OVERLAP) {
        // Not this part's outline, or a poor split of the photo: do not let it decide.
        photoMask = null;
        note = `The photo's outline matched no view of the part well (${Math.round(m.iou * 100)}%), so the inspector's rating scores the rounds.`;
      } else if (m) {
        view = { azimuthDeg: m.azimuthDeg, elevationDeg: m.elevationDeg };
        overlap = m.iou;
      }
    }
    const render = await deps.render(view);
    if (aborted()) return finish('stopped');

    // The critic (once more if its reply would not parse), and the measured check.
    progress(round, 'critic');
    let critic: { differences: string[]; match: number } | null = null;
    for (let attempt = 0; attempt < 2 && render && !critic; attempt++) {
      try {
        const reply = await deps.llm(CRITIC_SYSTEM, 'Compare the two pictures.', [opts.photos[0], render]);
        critic = parseCritic(reply.text);
      } catch {
        critic = null;
      }
      if (aborted()) return finish('stopped');
    }
    const measured = sizeDifferences(sizeMm(tris), overallMm);
    const differences = [...measured, ...(critic?.differences ?? [])];
    const scoreKind: RoundReport['scoreKind'] = overlap !== null ? 'overlap' : 'critic';
    // No outline and no inspector: nothing to score by. Keep the part if it is
    // the first, never let it replace or undo a scored one.
    const score = overlap ?? (critic ? critic.match / 10 : null);
    if (score === null) {
      note = [note, 'The inspector\'s reply could not be read, so this round was not scored.'].filter(Boolean).join(' ');
      if (!best) {
        best = { round, score: 0, nodes: deps.partNodes(), differences, render, view, build: built };
        sceneIsBest = true;
      } else {
        await deps.apply(best.nodes);
        sceneIsBest = true;
      }
      rounds.push({ round, score: 0, scoreKind, view, differences, rolledBack: best.round !== round, render, note });
      stale++;
      if (stale >= 2) return finish('no improvement');
      feedback = best.differences.map((d) => `- ${d}`).join('\n');
      continue;
    }

    // Keep it, or undo it.
    let rolledBack = false;
    if (best && score < best.score) {
      rolledBack = true;
      note = [note, `Scored ${score.toFixed(2)} against ${best.score.toFixed(2)} for round ${best.round}, so it was undone.`].filter(Boolean).join(' ');
      await deps.apply(best.nodes);
      sceneIsBest = true;
      feedback = `${best.differences.map((d) => `- ${d}`).join('\n')}\n\nYour last revision made the match WORSE (${scoreKind} ${best.score.toFixed(2)} -> ${score.toFixed(2)}) and was undone; the nodes above are the better version. Try a different fix.`;
      stale++;
    } else {
      // Only clearly better resets the count of rounds without progress.
      if (!best || score > best.score + SCORE_EPS) stale = 0;
      else stale++;
      best = { round, score, nodes: deps.partNodes(), differences, render, view, build: built };
      sceneIsBest = true;
      feedback = differences.map((d) => `- ${d}`).join('\n');
    }
    rounds.push({ round, score, scoreKind, view, differences, rolledBack, render, ...(note ? { note } : {}) });
    progress(round, 'critic');

    if (!rolledBack && differences.length === 0 && critic) return finish('matched');
    if (stale >= 2) return finish('no improvement');
  }
  return finish('round limit');
}

const STOPPED: Record<LoopReport['stoppedBecause'], string> = {
  matched: 'the inspector found nothing left to change',
  'no improvement': 'two rounds in a row did not improve the match',
  'round limit': 'it reached the round limit',
  stopped: 'you stopped it',
  failed: 'a round failed',
};

/** The report as chat markdown: one line a round, why it stopped, what is still off. */
export function formatLoopReport(r: LoopReport): string {
  const lines: string[] = ['### Picture to part'];
  if (!r.rounds.length) {
    lines.push(r.unchecked
      ? 'Stopped after the first build, before it was checked: the part in the scene is that build, unscored.'
      : `Nothing was built${r.error ? `: ${r.error}` : '.'}`);
    if (r.builderNotes) lines.push('', r.builderNotes);
    return lines.join('\n');
  }
  for (const round of r.rounds) {
    const pct = `${Math.round(round.score * 100)}%`;
    const what = round.scoreKind === 'overlap' ? `outline overlap ${pct}` : `inspector rating ${pct}`;
    if (round.failed) {
      lines.push(`- **Round ${round.round}**: ${round.note ?? 'did not build'}`);
      continue;
    }
    const tail = round.rolledBack ? ' (worse, undone)' : round.round === r.bestRound ? ' (kept)' : '';
    lines.push(`- **Round ${round.round}**: ${what}, ${round.differences.length} difference${round.differences.length === 1 ? '' : 's'}${tail}${round.note && !round.rolledBack ? `. ${round.note}` : ''}`);
  }
  lines.push('', `Stopped because ${STOPPED[r.stoppedBecause]}${r.error ? ` (${r.error})` : ''}. The part in the scene is round ${r.bestRound}'s; its sizes are sliders on the body.`);
  if (r.builderNotes) lines.push('', '**From the builder:**', r.builderNotes);
  if (r.remaining.length) {
    lines.push('', '**Still different from the photo:**', ...r.remaining.map((d) => `- ${d}`));
  }
  lines.push('', 'A photo cannot show the back, the inside or wall thickness: check those, and give a real dimension if the size is a guess.');
  return lines.join('\n');
}
