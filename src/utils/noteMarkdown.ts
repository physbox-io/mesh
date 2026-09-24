import { sanitizeNoteUrl } from '@physbox-io/ui';

// Markdown for a note card. Headings, emphasis, code, links and bullets;
// nothing else, because a note card is a label rather than a document.
export function parseNoteMarkdown(md: string): string {
  if (!md) return '';
  let html = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/^### (.*$)/gim, '<h3 class="text-xs font-bold text-slate-800 dark:text-slate-200 mt-2 mb-1 uppercase tracking-wide">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 class="text-sm font-bold text-slate-800 dark:text-slate-200 mt-3 mb-1 border-b border-slate-100 dark:border-slate-800 pb-0.5">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 class="text-base font-extrabold text-slate-900 dark:text-slate-100 mt-3 mb-2 border-b border-slate-200 dark:border-slate-800 pb-1">$1</h1>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900 dark:text-slate-100">$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em class="italic text-slate-700 dark:text-slate-300">$1</em>');
  html = html.replace(/`(.*?)`/g, '<code class="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-[10px] font-mono text-pink-600 dark:text-pink-400">$1</code>');
  // A link is the one place a note card's text reaches an HTML attribute, so
  // what may become an href is decided in @physbox-io/ui and shared with the
  // other apps. Anything else is left on the page as the text it was written
  // as, rather than becoming an anchor nobody can see the target of.
  html = html.replace(/\[(.*?)\]\((.*?)\)/g, (whole, label: string, url: string) => {
    const href = sanitizeNoteUrl(url);
    return href
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 hover:underline">${label}</a>`
      : whole;
  });
  html = html.replace(/^\s*-\s+(.*$)/gim, '<li class="ml-4 list-disc text-slate-600 dark:text-slate-300 text-xs mb-0.5">$1</li>');
  html = html.split('\n').map(line => {
    const t = line.trim();
    if (t.startsWith('<h') || t.startsWith('<li') || t === '') return line;
    return `<p class="text-xs text-slate-600 dark:text-slate-300 mb-1.5 leading-relaxed">${line}</p>`;
  }).join('\n');
  return html;
}
