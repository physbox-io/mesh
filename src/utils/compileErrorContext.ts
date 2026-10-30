// ---------------------------------------------------------------------------
// A MuJoCo compile error, said in the scene's terms.
//
// MuJoCo names the element it choked on by its line in the MJCF, or by a name
// the compiler made up: "Element name 'rope_coupling_linear_1', id 0, line 24"
// or "Element 'joint', line 17". Nobody calling physics_build_scene has seen
// that XML. The XML still knows which body a joint sits on and which joints a
// coupling ties, so the location is rewritten as the scene's bodies and
// joints, and MuJoCo's own reason is kept. Pure: no store, no DOM.
// ---------------------------------------------------------------------------

/** What the compiler's generated names stand for, by prefix. */
const GENERATED: [RegExp, string][] = [
  [/^rope_coupling_/, "a pulley rope's coupling (isPulleyRope: leftTargetId / rightTargetId / pulleyWheelId)"],
  [/^explicit_coupling_/, 'a coupling set by coupleTargetId'],
  [/^gear_coupling/, 'a coupling between two gears found meshing'],
  [/^pinion_rack_coupling/, 'a coupling between a pinion and a rack found meshing'],
  [/^connect_constraint_/, 'a pin set by connectTargetId'],
  [/^weld_constraint_/, 'a weld set by weldTargetId'],
  [/^crumple_lock_/, "a crumple zone's lock"],
];

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};

/** The body a position in the XML sits inside, by its name. */
const enclosingBody = (xml: string, at: number): string | null => {
  const stack: string[] = [];
  for (const m of xml.slice(0, at).matchAll(/<body\b([^>]*?)(\/?)>|<\/body>/g)) {
    if (m[0] === '</body>') stack.pop();
    else if (!m[2]) stack.push(attrs(m[1]).name ?? 'an unnamed body');
  }
  return stack.length ? stack[stack.length - 1] : null;
};

/** Where `<joint name="j">` is defined: its type, and the body it is on. */
const jointOwner = (xml: string, joint: string): { body: string | null; type: string } | null => {
  const from = Math.max(0, xml.indexOf('<worldbody'));
  const re = new RegExp(`<(joint|freejoint)\\b[^>]*\\bname="${joint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`);
  const m = re.exec(xml.slice(from));
  if (!m) return null;
  const type = m[1] === 'freejoint' ? 'free' : (attrs(m[0]).type ?? 'hinge');
  return { body: enclosingBody(xml, from + m.index), type };
};

const jointPhrase = (xml: string, j: string) => {
  const owner = jointOwner(xml, j);
  if (!owner) return `joint '${j}'`;
  return `${owner.type} joint '${j}'${owner.body ? ` on body '${owner.body}'` : ''}`;
};

/** The element at `line` MuJoCo means: by its name if it gave one, else its tag. */
const findElement = (xml: string, line: number, name: string | null, tag: string | null) => {
  const lines = xml.split('\n');
  if (line < 1 || line > lines.length) return null;
  const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  const text = lines[line - 1];
  for (const m of text.matchAll(/<(\w+)\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if ((name && a.name === name) || (!name && tag && m[1] === tag)) {
      return { tag: m[1], a, at: start + (m.index ?? 0) };
    }
  }
  return null;
};

const describe = (xml: string, el: { tag: string; a: Record<string, string>; at: number }, keyword: string | null): string => {
  const { tag, a } = el;
  const what = (() => {
    const generated = a.name ? GENERATED.find(([re]) => re.test(a.name))?.[1] : undefined;
    const joints = [a.joint1, a.joint2].filter((j): j is string => !!j);
    if (a.tendon1 || (tag === 'fixed' && !joints.length)) {
      // A coupling held as a fixed tendon names its joints in the tendon.
      const ten = a.tendon1 ?? a.name;
      const m = new RegExp(`<fixed\\b[^>]*name="${ten}"[^>]*>([\\s\\S]*?)</fixed>`).exec(xml);
      if (m) for (const j of m[1].matchAll(/joint="([^"]+)"/g)) joints.push(j[1]);
    }
    const label = generated ? `${generated}, ${a.name}` : `${tag} '${a.name ?? '(unnamed)'}'`;
    if (tag === 'body') return `body '${a.name}'`;
    if (tag === 'joint' && a.joint && !a.name) return jointPhrase(xml, a.joint);
    if (tag === 'geom' || (tag === 'joint' && !a.joint1)) {
      const body = enclosingBody(xml, el.at);
      return `${tag} '${a.name ?? '(unnamed)'}'${body ? ` on body '${body}'` : ''}`;
    }
    if (joints.length) return `${label}, between ${joints.map((j) => jointPhrase(xml, j)).join(' and ')}`;
    if (a.body1) return `${label}, between body '${a.body1}' and ${a.body2 ? `body '${a.body2}'` : 'the world'}`;
    return label;
  })();
  const field = keyword ? Object.entries(a).find(([, v]) => v === keyword)?.[0] : undefined;
  return field ? `${what} (its ${field} is '${keyword}')` : what;
};

/**
 * MuJoCo's message with its XML location replaced by the scene's names.
 * A message with no location, or one that cannot be placed, comes back as it was.
 */
export function explainCompileError(message: string, xml: string | undefined): string {
  if (!xml) return message;
  const loc = /\n?\s*Element (?:name '([^']*)'|'(\w+)')(?:, id \d+)?, line (\d+)\s*/.exec(message);
  if (!loc) return message;
  const el = findElement(xml, Number(loc[3]), loc[1] ?? null, loc[2] ?? null);
  if (!el) return message;
  const keyword = /invalid keyword: '([^']*)'/.exec(message)?.[1] ?? null;
  const reason = message.slice(0, loc.index).replace(/^(MuJoCo Error: )?Loading error: (XML )?Error: /, '').trim();
  return `MuJoCo could not build the scene: ${reason}, in ${describe(xml, el, keyword)}.`;
}
