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
import { extractJSON, parseAIResponse } from './copilotReply';
import { bestView, type Mask, type View } from './silhouette';

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
}

export const DEFAULT_LOOP_ROUNDS = 5;
/** A round has to beat the best by more than this to count as better, and lose more than it to be undone. */
const SCORE_EPS = 0.02;

const BUILDER_RULES = `
═══════════════════════════════════════════
PICTURE TO PART
═══════════════════════════════════════════
You are building a real part to match the attached photo(s), at real size. Follow 9i (pictures).
Output ONE json block: {"nodes": [...], "view": {"azimuthDeg": A, "elevationDeg": E}, "overallMm": [x, y, z] | null}
- nodes: the whole part, preferably one SCAD body with every size a top-level variable.
- view: the direction the FIRST photo was taken from. azimuthDeg round the vertical: 0 = from the part's front (camera on -Y), 90 = from +X (its right), 180 = from behind. elevationDeg: 0 = level, 90 = straight down. Lay the part so its front faces -Y.
- overallMm: the overall size along world X, Y, Z ONLY if the picture states it (written or with a scale reference); otherwise null.
On a revision you get the current nodes, the photos, a render of your part from the first photo's direction, and an inspector's list of differences. Fix them, keep what already matches, and return the whole part again in the same block.`;

const CRITIC_SYSTEM = `You are an inspector. The FIRST picture is a photo of a real object. The SECOND is a render of a CAD model meant to copy it, seen from about the same direction. You did not build the model; your job is to find where it is wrong.
List every visible difference in shape, proportion and features: holes, slots, bosses, ribs, fillets, chamfers, steps, lettering, parts missing or extra. Most important first, one sentence each, saying what to change and by roughly how much ("the handle is about a third longer in the photo", "the photo has two mounting holes, the model one").
Ignore colour, material, lighting, shadows, background, the floor grid and perspective distortion.
Reply ONLY with: \`\`\`json {"differences": ["..."], "match": N} \`\`\` where match is 0-10 for how well the model's visible shape matches. An empty list means it matches in everything you can see.`;

function parseBuild(text: string): { nodes: RawNode[] | null; view?: View; overallMm?: [number, number, number] } {
  const { nodes } = parseAIResponse(text);
  let view: View | undefined;
  let overallMm: [number, number, number] | undefined;
  const blocks = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/gi) ?? [text];
  for (const b of blocks) {
    const j = extractJSON(b.replace(/^```(?:json)?|```$/gi, '')) as Record<string, unknown> | null;
    if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
    const v = j.view as Record<string, unknown> | undefined;
    if (!view && v && Number.isFinite(Number(v.azimuthDeg)) && Number.isFinite(Number(v.elevationDeg))) {
      view = { azimuthDeg: ((Number(v.azimuthDeg) % 360) + 360) % 360, elevationDeg: Math.max(0, Math.min(90, Number(v.elevationDeg))) };
    }
    const o = j.overallMm;
    if (!overallMm && Array.isArray(o) && o.length === 3 && o.every((x) => Number(x) > 0)) {
      overallMm = o.map(Number) as [number, number, number];
    }
  }
  return { nodes, view, overallMm };
}

function parseCritic(text: string): { differences: string[]; match: number } | null {
  const j = extractJSON(text) as Record<string, unknown> | null;
  if (!j || typeof j !== 'object' || !Array.isArray(j.differences)) return null;
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

  let best: { round: number; score: number; nodes: RawNode[]; differences: string[]; render: LlmImage | null } | null = null;
  let guess: View | undefined;
  let overallMm: [number, number, number] | undefined;
  let feedback = '';
  let stale = 0;
  const finish = (stoppedBecause: LoopReport['stoppedBecause'], error?: string): LoopReport => {
    progress(rounds.length, 'done');
    return {
      rounds,
      bestRound: best?.round ?? 0,
      remaining: best?.differences ?? [],
      stoppedBecause,
      ...(error ? { error } : {}),
    };
  };

  for (let round = 1; round <= maxRounds; round++) {
    if (aborted()) return finish('stopped');

    // Build or revise.
    progress(round, round === 1 ? 'building' : 'revising');
    const user = round === 1
      ? `${opts.request || 'Build the part shown in the picture.'}`
      : `CURRENT PART NODES:\n${JSON.stringify(deps.partNodes())}\n\nINSPECTOR'S DIFFERENCES (photo vs your part, the last picture is your part from the photo's direction):\n${feedback}\n\nOriginal request: ${opts.request || 'Build the part shown in the picture.'}`;
    // After a revision the builder sees the part that was kept, which after an undo is not the last one drawn.
    const images = round === 1 || !best?.render ? opts.photos : [...opts.photos, best.render];
    let built: ReturnType<typeof parseBuild> | null = null;
    let applyError = '';
    for (let attempt = 0; attempt < 2 && !built; attempt++) {
      let reply: LlmResult;
      try {
        reply = await deps.llm(builderSystem, attempt ? `${user}\n\nYOUR LAST REPLY FAILED: ${applyError} Return the whole part again.` : user, images);
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
      if (!res.ok) {
        applyError = res.error || 'The part did not build.';
        continue;
      }
      built = parsed;
    }
    if (!built) {
      if (best) {
        await deps.apply(best.nodes);
        rounds.push({ round, score: best.score, scoreKind: opts.photoMask ? 'overlap' : 'critic', view: guess ?? { azimuthDeg: 30, elevationDeg: 25 }, differences: [], rolledBack: true, render: null, note: `The builder's revision did not build (${applyError}), so round ${best.round}'s part stands.` });
        return finish('failed', applyError);
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
    if (opts.photoMask) {
      const m = bestView(tris, opts.photoMask, guess);
      if (m) {
        view = { azimuthDeg: m.azimuthDeg, elevationDeg: m.elevationDeg };
        overlap = m.iou;
      }
    }
    const render = await deps.render(view);
    if (aborted()) return finish('stopped');

    // The critic, and the measured check.
    progress(round, 'critic');
    let critic: { differences: string[]; match: number } | null = null;
    if (render) {
      try {
        const reply = await deps.llm(CRITIC_SYSTEM, 'Compare the two pictures.', [opts.photos[0], render]);
        critic = parseCritic(reply.text);
      } catch {
        critic = null;
      }
    }
    if (aborted()) return finish('stopped');
    const measured = sizeDifferences(sizeMm(tris), overallMm);
    const differences = [...measured, ...(critic?.differences ?? [])];
    const scoreKind: RoundReport['scoreKind'] = overlap !== null ? 'overlap' : 'critic';
    const score = overlap ?? (critic ? critic.match / 10 : 0);

    // Keep it, or undo it.
    let rolledBack = false;
    let note: string | undefined;
    if (best && score < best.score - SCORE_EPS) {
      rolledBack = true;
      note = `Scored ${score.toFixed(2)} against ${best.score.toFixed(2)} for round ${best.round}, so it was undone.`;
      await deps.apply(best.nodes);
      feedback = `${best.differences.map((d) => `- ${d}`).join('\n')}\n\nYour last revision made the match WORSE (${scoreKind} ${best.score.toFixed(2)} -> ${score.toFixed(2)}) and was undone; the nodes above are the better version. Try a different fix.`;
      stale++;
    } else {
      if (!best || score > best.score + SCORE_EPS) stale = 0;
      else stale++;
      best = { round, score, nodes: deps.partNodes(), differences, render };
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
    lines.push(`Nothing was built${r.error ? `: ${r.error}` : '.'}`);
    return lines.join('\n');
  }
  for (const round of r.rounds) {
    const pct = `${Math.round(round.score * 100)}%`;
    const what = round.scoreKind === 'overlap' ? `outline overlap ${pct}` : `inspector rating ${pct}`;
    const tail = round.rolledBack ? ' (worse, undone)' : round.round === r.bestRound ? ' (kept)' : '';
    lines.push(`- **Round ${round.round}**: ${what}, ${round.differences.length} difference${round.differences.length === 1 ? '' : 's'}${tail}`);
  }
  lines.push('', `Stopped because ${STOPPED[r.stoppedBecause]}${r.error ? ` (${r.error})` : ''}. The part in the scene is round ${r.bestRound}'s; its sizes are sliders on the body.`);
  if (r.remaining.length) {
    lines.push('', '**Still different from the photo:**', ...r.remaining.map((d) => `- ${d}`));
  }
  lines.push('', 'A photo cannot show the back, the inside or wall thickness: check those, and give a real dimension if the size is a guess.');
  return lines.join('\n');
}
