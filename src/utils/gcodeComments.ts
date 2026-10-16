/**
 * Splits one G-code line into the code and the text of its comments.
 *
 * G-code has two comment syntaxes, `(...)` and `; to end of line`, and they
 * have to be read in one pass from the left. A `;` inside parentheses is part
 * of that comment, not the start of another: `(Tool 1; 3mm flat) G0 Z5` is a
 * rapid, and cutting it at the semicolon sent the controller `(Tool 1`, an
 * unclosed comment it rejects. Parentheses after a `;` are just comment text.
 */
export function splitGcodeComments(raw: string): { code: string; notes: string[] } {
  let code = '';
  const notes: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === ';') {
      notes.push(raw.slice(i + 1).trim());
      break;
    }
    if (ch === '(') {
      const close = raw.indexOf(')', i + 1);
      // An unclosed paren runs to the end of the line, as GRBL reads it.
      const end = close < 0 ? raw.length : close;
      notes.push(raw.slice(i + 1, end).trim());
      code += ' ';
      i = end + 1;
      continue;
    }
    code += ch;
    i++;
  }
  return { code: code.replace(/\s+/g, ' ').trim(), notes: notes.filter(Boolean) };
}
