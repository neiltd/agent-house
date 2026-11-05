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
 * @returns {{ title: string, asks: Array<{ num: string, title: string, chip: string, urgency: string, open: boolean, what: string, answer: string }> }}
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
    asks.push({
      num, title: clip(t, 160), chip, urgency, open,
      what: clip(firstPara(field(body, /^what$/i)), 260),
      answer: clip(plain(field(body, /^(your answer|answer|reply)$/i)), 200),
    });
  }
  return { title, asks };
}
