// Reads an Inbox page (the HTML a session publishes as an Artifact) and pulls out its ask cards.
// Pure function, no I/O. Handles both layouts in use:
//   our club:   <article class="ask" id="ask27" [hidden]> <h2>27. Title</h2> <span class="chip c-now">Now</span>
//   AI Capital: <article class="ask"> <h3><span class="num">25</span>Title</h3> <span class="chip c-later">Sun 8 Nov</span>

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…' };
export function plain(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ').trim();
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const DONE = /^(done|answered|closed|sent|resolved)\b/i;
const NOT_ON_YOU = /^(waiting on|in progress)\b/i; // open, but someone else has the next move

/** Text of the <dd> that follows a <dt> whose label matches `re`, or ''. */
function field(body, re) {
  const parts = body.split(/<dt[^>]*>/i).slice(1);
  for (const p of parts) {
    const label = plain(p.split(/<\/dt>/i)[0]);
    if (re.test(label)) { const dd = p.match(/<dd[^>]*>([\s\S]*?)(?:<\/dd>|$)/i); return dd ? dd[1] : ''; }
  }
  return '';
}

/** First paragraph (or the whole field if it has none) as plain text. */
function firstPara(html) {
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return plain(p ? p[1] : html);
}

/**
 * @returns {{ title: string, asks: Array<{ num, title, chip, urgency, open, what, why, options: [{text, pick, by}], pick, by, answer, then }> }}
 * Reads both the shared format (data-urgency / data-status / data-by, <ol class="opts"> with <li class="pick">) and older pages.
 */
export function parseInbox(html) {
  const s = String(html || '');
  const title = plain((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const asks = [];
  const re = /<article\b([^>]*)>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = re.exec(s))) {
    const attrs = m[1], body = m[2];
    if (!/class\s*=\s*"[^"]*\bask\b/i.test(attrs)) continue;
    const hidden = /\shidden(\s|=|$)/i.test(attrs);
    const head = (body.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i) || [])[1] || '';
    let num = plain((head.match(/<span[^>]*class="[^"]*\bnum\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '');
    let t = plain(head.replace(/<span[^>]*class="[^"]*\bnum\b[^"]*"[^>]*>[\s\S]*?<\/span>/i, ''));
    const lead = t.match(/^(\d+[a-z]?)\.\s*/i);
    if (lead) { num = num || lead[1]; t = t.slice(lead[0].length); }
    if (!num) num = ((attrs.match(/id\s*=\s*"ask(\d+[a-z]?)"/i) || [])[1]) || '';
    const chipM = body.match(/<span[^>]*class="([^"]*\bchip\b[^"]*)"[^>]*>([\s\S]*?)<\/span>/i);
    const chip = chipM ? plain(chipM[2]) : '';
    const urgency = chipM ? ((chipM[1].match(/\bc-(now|soon|later)\b/) || [])[1] || '') : '';
    const open = !hidden && !DONE.test(chip) && !NOT_ON_YOU.test(chip);
    const dataUrg = (attrs.match(/data-urgency\s*=\s*"(now|soon|later)"/i) || [])[1];
    const dataStatus = (attrs.match(/data-status\s*=\s*"([a-z-]+)"/i) || [])[1];
    const isOpen = dataStatus ? dataStatus === 'open' && !hidden : open;
    // "Options"/"Choices" are choices. A "How" list is steps, unless it's marked as options (<ul class="opts">).
    const howHtml = field(body, /^how$/i);
    const optsHtml = field(body, /^(options|choices)$/i) || (/class\s*=\s*"[^"]*\bopts\b/i.test(howHtml) ? howHtml : '');
    const options = parseOptions(optsHtml);
    const steps = optsHtml === howHtml ? [] : parseOptions(howHtml).map((o) => o.text);
    const pickLine = plain(body).match(/\bMy (?:pick|view|suggestion)[:.]?\s*([^.]{0,140})/i);
    const by = (attrs.match(/data-by\s*=\s*"([^"]{1,40})"/i) || [])[1] || suggestedBy(plain(body));
    asks.push({
      num, title: clip(t, 160), chip, urgency: dataUrg || urgency, open: isOpen,
      what: clip(firstPara(field(body, /^what$/i)), 1200),
      why: clip(plain(field(body, /^(why|why you|why it matters)$/i)), 1200),
      options,
      pick: options.find((o) => o.pick)?.text || (pickLine ? clip(pickLine[1].trim(), 140) : ''),
      by,
      answer: clip(plain(field(body, /^(your answer|answer|reply)$/i)), 200),
      then: clip(plain(field(body, /^(then|after|next)$/i)), 1200),
      steps,
    });
  }
  return { title, asks };
}

/** Options from <ol>/<ul> items; an option is the recommended one if it has class "pick" or says "my pick" / "(recommended)". */
function parseOptions(html) {
  const out = [];
  const re = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi; let m;
  while ((m = re.exec(html || '')) && out.length < 8) {
    const text = plain(m[2]);
    if (!text) continue;
    const pick = /class\s*=\s*"[^"]*\bpick\b/i.test(m[1]) || /\bmy pick\b|\(recommended\)|\brecommended\b/i.test(text);
    const by = (m[1].match(/data-by\s*=\s*"([^"]{1,40})"/i) || [])[1] || '';
    out.push({ text: clip(text.replace(/\s*\(recommended\)\s*/i, ' ').trim(), 600), pick, by });
  }
  return out;
}

/** Who suggested it, from phrases like "Alex suggests", "Sam wants", "Jo's pick", "Lee's view". */
function suggestedBy(text) {
  const m = String(text).match(/\b([A-Z][a-z]+(?: [A-Z][a-z']+)?)(?:'s (?:pick|view|suggestion)| (?:suggests|recommends|wants|proposes))\b/);
  return m ? m[1] : '';
}

/**
 * A NEEDS-USER.md file (the relay style): the question first, then numbered options, one marked "(Recommended)".
 * It's open until an "ANSWER" section appears.
 */
export function parseNeedsUser(md, { title = 'Needs you' } = {}) {
  const s = String(md || '');
  if (!s.trim()) return { title, asks: [] };
  const answered = /^-{3,}\s*$[\s\S]*^\s*ANSWER\b/m.test(s) || /^\s*ANSWER\b/m.test(s);
  const lines = s.split(/\r?\n/);
  const firstOpt = lines.findIndex((l) => /^\s*\d+\.\s+/.test(l));
  const what = lines.slice(0, firstOpt < 0 ? lines.length : firstOpt).join(' ').replace(/\s+/g, ' ').trim();
  const options = [];
  if (firstOpt >= 0) {
    let cur = null;
    for (const l of lines.slice(firstOpt)) {
      if (/^-{3,}\s*$/.test(l)) break;
      const om = l.match(/^\s*\d+\.\s+(.*)$/);
      if (om) { cur = { text: om[1], pick: false, by: '' }; options.push(cur); } else if (cur && l.trim()) cur.text += ' ' + l.trim();
    }
    for (const o of options) { o.pick = /\(recommended\)/i.test(o.text); o.text = clip(o.text.replace(/\(recommended\)\s*/i, '').trim(), 260); }
  }
  const head = what.split(/(?<=[.?!])\s/)[0] || what;
  return { title, asks: [{ num: '', title: clip(head, 160), chip: answered ? 'Answered' : 'Now', urgency: answered ? 'later' : 'now', open: !answered,
    what: clip(what, 600), why: '', options, pick: options.find((o) => o.pick)?.text || '', by: suggestedBy(s), answer: 'Reply in the project\'s relay with the option number.', then: '' }] };
}
