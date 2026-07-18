/*
 * annotator-core.js — source-level annotation logic shared by the browser app
 * (index.html) and the headless test harness (.lab/workspace/harness).
 *
 * Pure functions over markdown *source strings* — no DOM. The browser handles
 * DOM selection → source range/offset; this module decides whether a target is
 * annotatable, builds the annotated source, and renders for structural compare.
 *
 * Works as a <script> global (window.AnnotatorCore) and as a CommonJS module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AnnotatorCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // CriticMarkup forms, tried in this order at each position:
  //   1) paired highlight+comment {== text ==}{>> comment <<}  (groups 1,2)
  //   2) standalone highlight      {== text ==}                (group 3)
  //   3) standalone point comment  {>> comment <<}             (group 4)
  //   4) deletion                  {-- text --}                (group 5)
  //   5) insertion                 {++ text ++}                (group 6)
  //   6) substitution              {~~ old ~> new ~~}          (groups 7,8)
  // Standalone highlights are used for the non-last blocks of a multi-block
  // annotation, which all share the single trailing comment (one "group").
  // Text/comment groups are "tempered" so they cannot span across their own
  // closer (==} / <<} / --} / ++} / ~~}); otherwise a standalone highlight
  // between a {==…==} and a later {>>…<<} would be swallowed into one giant
  // pair match.
  const CM_ANY = /\{==\s*((?:(?!==\})[\s\S])*?)\s*==\}\{>>\s*((?:(?!<<\})[\s\S])*?)\s*<<\}|\{==\s*((?:(?!==\})[\s\S])*?)\s*==\}|\{>>\s*((?:(?!<<\})[\s\S])*?)\s*<<\}|\{--((?:(?!--\})[\s\S])*?)--\}|\{\+\+((?:(?!\+\+\})[\s\S])*?)\+\+\}|\{~~((?:(?!~>|~~\})[\s\S])*?)~>((?:(?!~~\})[\s\S])*?)~~\}/g;

  // Parse all annotations in document order, assigning a GROUP id: a run of
  // standalone highlights binds to the following paired comment (they form one
  // logical annotation); a lone pair or point is its own group.
  function scanAnnotations(src) {
    const re = new RegExp(CM_ANY.source, 'g');
    const items = [];
    let m, gid = 0, pending = [];
    while ((m = re.exec(src)) !== null) {
      let it;
      if (m[1] !== undefined) it = { kind: 'pair', text: m[1], comment: m[2] };
      else if (m[3] !== undefined) it = { kind: 'highlight', text: m[3], comment: '' };
      else if (m[4] !== undefined) it = { kind: 'point', text: '', comment: m[4] };
      else if (m[5] !== undefined) it = { kind: 'del', text: m[5], comment: '' };
      else if (m[6] !== undefined) it = { kind: 'ins', text: m[6], comment: '' };
      else it = { kind: 'sub', text: m[7], text2: m[8], comment: '' };
      it.mStart = m.index; it.mEnd = m.index + m[0].length;
      if (it.kind === 'highlight') { it.group = -1; pending.push(it); }
      else if (it.kind === 'pair') { const g = gid++; pending.forEach(p => p.group = g); pending = []; it.group = g; }
      else { pending.forEach(p => p.group = gid++); pending = []; it.group = gid++; }
      items.push(it);
    }
    pending.forEach(p => { if (p.group < 0) p.group = gid++; });
    return items;
  }

  // Rewrite the source by replacing every annotation in `group`. Highlights and
  // pairs unwrap to their text; points vanish. For suggested edits this is the
  // REJECT action: deletion keeps the original text, insertion vanishes, and a
  // substitution reverts to the old text. Right-to-left to keep offsets valid.
  function deleteGroup(src, group) {
    return replaceGroup(src, group, function (it) {
      if (it.kind === 'point' || it.kind === 'ins') return '';
      if (it.kind === 'del') return it.text;
      if (it.kind === 'sub') return it.text;
      return it.text.trim();
    });
  }

  // ACCEPT a suggested edit: deletion removes the text, insertion keeps it,
  // substitution takes the new text. Comment kinds unwrap like deleteGroup.
  function acceptGroup(src, group) {
    return replaceGroup(src, group, function (it) {
      if (it.kind === 'point' || it.kind === 'del') return '';
      if (it.kind === 'ins') return it.text;
      if (it.kind === 'sub') return it.text2;
      return it.text.trim();
    });
  }

  function replaceGroup(src, group, replacement) {
    let out = src;
    const items = scanAnnotations(src);
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k];
      if (it.group !== group) continue;
      out = out.slice(0, it.mStart) + replacement(it) + out.slice(it.mEnd);
    }
    return out;
  }

  // Wrap [start,end) in a substitution suggestion {~~old~>new~~}.
  function suggestEdit(src, start, end, replacement) {
    const old = src.slice(start, end);
    return src.slice(0, start) + '{~~' + old + '~>' + replacement + '~~}' + src.slice(end);
  }

  // Change a group's comment (only its pair/point member carries the comment).
  // Suggested edits (del/ins/sub) carry no comment and are left untouched.
  function updateGroup(src, group, newComment) {
    let out = src;
    const items = scanAnnotations(src);
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k];
      if (it.group !== group) continue;
      if (it.kind === 'del' || it.kind === 'ins' || it.kind === 'sub') continue;
      let rep;
      if (it.kind === 'point') rep = '{>> ' + newComment + ' <<}';
      else if (it.kind === 'pair') rep = '{== ' + it.text.trim() + ' ==}{>> ' + newComment + ' <<}';
      else rep = '{== ' + it.text.trim() + ' ==}';
      out = out.slice(0, it.mStart) + rep + out.slice(it.mEnd);
    }
    return out;
  }

  function getGroupComment(src, group) {
    for (const it of scanAnnotations(src)) {
      if (it.group === group && (it.kind === 'pair' || it.kind === 'point')) return it.comment.trim();
    }
    return '';
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Document-comment zone: optional YAML frontmatter, then a run of standalone
  // point comments separated only by whitespace. Returns { end, items } where
  // `end` is the offset new doc comments insert at and `items` are the
  // scanAnnotations entries living in the zone.
  function docZone(src) {
    let pos = 0;
    const fm = src.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
    if (fm) pos = fm[0].length;
    const items = [];
    for (const it of scanAnnotations(src)) {
      if (it.kind !== 'point') break;
      if (it.mStart < pos) continue;                      // inside frontmatter text
      if (src.slice(pos, it.mStart).trim() !== '') break;  // real content before it
      items.push(it);
      pos = it.mEnd;
    }
    return { end: pos, items };
  }

  // Find [start,end) ranges of fenced code blocks in the source.
  // CRLF-aware: JS `.` does not match `\r`, so the old `.*\n` pattern silently
  // matched nothing on Windows (CRLF) files. Use `[^\r\n]*` + `\r?\n` and allow
  // indentation/trailing space around the closing fence.
  function codeFenceRanges(src) {
    const ranges = [];
    const fenceRegex = /^(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)/gm;
    let fm;
    while ((fm = fenceRegex.exec(src)) !== null) {
      ranges.push([fm.index, fm.index + fm[0].length]);
    }
    return ranges;
  }

  function inAnyRange(pos, ranges) {
    return ranges.some(([s, e]) => pos >= s && pos < e);
  }

  // Convert source containing CriticMarkup into HTML-ready text with annotation
  // markup replaced by placeholder tokens (so md parsing isn't disturbed by the
  // markup's pipes/braces). Annotations inside code fences are left literal.
  // Returns { preprocessed, count, placeholders }, each placeholder carrying both
  // the rendered HTML (for the app) and the plain text (for structural compare).
  function preprocessCriticMarkup(src) {
    const placeholders = [];
    const fences = codeFenceRanges(src);
    const items = scanAnnotations(src);
    let out = '', last = 0, i = 0;
    for (const it of items) {
      if (inAnyRange(it.mStart, fences)) continue; // leave literal inside code fences
      const placeholder = '​ANN' + i + '​';
      placeholders.push({ placeholder, i, kind: it.kind, text: it.text, text2: it.text2, comment: (it.comment || '').trim(), group: it.group });
      out += src.slice(last, it.mStart) + placeholder;
      last = it.mEnd;
      i++;
    }
    out += src.slice(last);
    return { preprocessed: out, count: i, placeholders };
  }

  // Build the HTML for one annotation placeholder. Highlighted text is rendered
  // as inline markdown (so **bold**/`code`/[links] inside a highlight keep their
  // formatting). data-ann-group links the blocks of a multi-block annotation so
  // edit/delete act on the whole group.
  function annHtml(md, e) {
    const c = escapeHtml(e.comment);
    const g = e.group;
    const attrs = 'data-ann-idx="' + e.i + '" data-ann-group="' + g + '"';
    const badge = '<span class="ann-comment-badge" ' + attrs + ' title="' + c + '">';
    const delBtn = '<button class="ann-delete" data-ann-group="' + g + '">&times;</button>';
    if (e.kind === 'point') {
      return '<span class="ann-wrap ann-point" ' + attrs + '>' + badge + '&#128172; ' + c + delBtn + '</span></span>';
    }
    if (e.kind === 'del' || e.kind === 'ins' || e.kind === 'sub') {
      // Suggested edit: strike the old text, underline the new; hover reveals
      // accept (✓) / reject (✗) controls.
      const inline = function (t) { return (md && md.renderInline) ? md.renderInline(t) : escapeHtml(t); };
      let body = '';
      if (e.kind !== 'ins') body += '<del class="ann-del">' + inline(e.text) + '</del>';
      if (e.kind === 'ins') body += '<ins class="ann-ins">' + inline(e.text) + '</ins>';
      if (e.kind === 'sub') body += '<ins class="ann-ins">' + inline(e.text2 || '') + '</ins>';
      const controls = '<span class="ann-edit-controls">' +
        '<button class="ann-accept" data-ann-group="' + g + '" title="Accept suggestion">&#10003;</button>' +
        '<button class="ann-reject" data-ann-group="' + g + '" title="Reject suggestion">&#10005;</button></span>';
      return '<span class="ann-wrap ann-edit" ' + attrs + '>' + body + controls + '</span>';
    }
    const inner = (md && md.renderInline) ? md.renderInline(e.text) : escapeHtml(e.text);
    const mark = '<mark class="ann-highlight">' + inner + '</mark>';
    if (e.kind === 'highlight') {
      // Part of a multi-block group — highlight only, no badge (the comment lives
      // on the group's last block); still offer a hover-× that deletes the group.
      return '<span class="ann-wrap ann-hl" ' + attrs + '>' + mark + '<button class="ann-delete ann-delete-hl" data-ann-group="' + g + '">&times;</button></span>';
    }
    return '<span class="ann-wrap" ' + attrs + '>' + mark + badge + c + delBtn + '</span></span>';
  }

  // Apply the mermaid fence override to a markdown-it instance (shared config).
  function configureMd(md) {
    const defaultFence = md.renderer.rules.fence ||
      ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.fence = function (tokens, idx, options, env, self) {
      const token = tokens[idx];
      const info = (token.info || '').trim().toLowerCase();
      if (info === 'mermaid') {
        return '<div class="mermaid">' + escapeHtml(token.content) + '</div>';
      }
      return defaultFence(tokens, idx, options, env, self);
    };
    return md;
  }

  // Full render pipeline as the browser does it: CriticMarkup → placeholders →
  // md.render → swap placeholders back to real annotation HTML.
  function renderAnnotated(md, src) {
    const { preprocessed, placeholders } = preprocessCriticMarkup(src);
    let html = md.render(preprocessed);
    for (const e of placeholders) {
      html = html.split(e.placeholder).join(annHtml(md, e));
    }
    return html;
  }

  // Remove an annotation's OWN contribution from rendered HTML, leaving the
  // original content. Paired → keep the highlighted text; point → remove
  // entirely; then drop any block wrapper the annotation left empty. What
  // remains must equal the un-annotated render iff formatting wasn't broken.
  function stripAnnotationHtml(html) {
    let h = html;
    h = h.replace(/<button class="ann-delete[^"]*"[^>]*>[\s\S]*?<\/button>/g, '');
    h = h.replace(/<span class="ann-comment-badge[^"]*"[^>]*>[\s\S]*?<\/span>/g, '');
    h = h.replace(/<mark class="ann-highlight">([\s\S]*?)<\/mark>/g, '$1');
    h = h.replace(/<span class="ann-wrap[^"]*"[^>]*>([\s\S]*?)<\/span>/g, '$1');
    h = h.replace(/[​]/g, '');
    h = h.replace(/<p>\s*<\/p>/g, '');
    return h;
  }

  // Normalize for structural comparison. Cosmetic typography (smart quotes,
  // dashes, ellipsis produced by markdown-it's typographer) is folded to a
  // canonical form: an annotated word whose apostrophe renders straight instead
  // of curly is not "breaking the document", so it must stay annotatable.
  function normalizeHtml(html) {
    return html
      .replace(/[​]/g, '')
      .replace(/[‘’ʼ']/g, "'")
      .replace(/[“”"]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/…/g, '...')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Does annotating produce a doc whose ORIGINAL content still renders
  // identically? (The annotation's own badge/markup is excluded — adding a
  // comment is the intended effect, not "breaking formatting".)
  // Compare the ORIGINAL doc and the candidate with BOTH rendered through the
  // annotation pipeline and stripped — so any annotations ALREADY in the doc are
  // handled identically on both sides, and only the new annotation's effect is
  // tested. (Using md.render(originalSrc) directly would render existing
  // CriticMarkup as literal text and wrongly reject every further annotation.)
  function isStructurePreserved(md, originalSrc, annotatedSrc) {
    const base = normalizeHtml(stripAnnotationHtml(renderAnnotated(md, originalSrc)));
    const stripped = normalizeHtml(stripAnnotationHtml(renderAnnotated(md, annotatedSrc)));
    return base === stripped;
  }

  // ── Targeting / classification ─────────────────────────────────────────────
  // target: { type:'range', start, end }  |  { type:'point', pos }
  // Returns: { supported, kind, inserts:[...], reason }
  //   insert types: {type:'pair',start,end} | {type:'point',pos} | {type:'blockComment',pos}
  //
  // Builds candidate insertions in priority order and returns the first one that
  // PRESERVES the document's rendered structure (validated with `md`). If none
  // does, the target is unsupported — the caller must notify and NOT open the
  // dialog. With validation, supported insertions never break formatting.
  function fenceContaining(pos, fences) {
    return fences.find(([s, e]) => pos >= s && pos < e) || null;
  }

  function trimToContent(src, s, e) {
    const lead = src.slice(s, e).match(/^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)*)/);
    let a = s + (lead ? lead[0].length : 0);
    let b = e;
    while (b > a && /\s/.test(src[b - 1])) b--;
    while (a < b && /\s/.test(src[a])) a++;
    return [a, b];
  }

  // Split a range into per-BLOCK content segments. Consecutive soft-wrapped
  // paragraph lines merge into one segment (so a multi-line paragraph is ONE
  // annotation); headings, list items and blockquote lines are each their own
  // segment; blank lines, thematic breaks and code-fence interiors are skipped.
  // Inline markdown inside a segment is preserved (the highlight renders it),
  // so a segment can safely span **bold**/links/`code`.
  function splitRangeIntoSegments(src, start, end, fences) {
    const segs = [];
    let cur = null;
    const flush = () => { if (cur && cur[1] > cur[0]) segs.push(cur); cur = null; };
    let off = start;
    for (const piece of src.slice(start, end).split('\n')) {
      const ps = off, pe = off + piece.length;
      off = pe + 1; // for the consumed '\n'
      const interiorFence = inAnyRange(ps, fences) && inAnyRange(Math.max(ps, pe - 1), fences);
      const blank = !/\S/.test(piece);
      const hr = /^\s*([-*_])(\s*\1){2,}\s*$/.test(piece);
      if (interiorFence || blank || hr) { flush(); continue; }
      const t = trimToContent(src, ps, pe);
      if (!t || t[1] <= t[0] || !/[A-Za-z0-9]/.test(src.slice(t[0], t[1]))) { flush(); continue; }
      const ownBlock = /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>)/.test(piece); // heading/list/quote
      if (ownBlock) { flush(); segs.push(t); continue; }
      if (cur) cur[1] = t[1]; else cur = [t[0], t[1]]; // merge paragraph line
    }
    flush();
    return segs;
  }

  // Split a range into individual word runs (outside code fences). Wrapping each
  // word separately leaves inline markers (**, *, `, [], ()) outside the wraps,
  // so emphasis/links/code spans survive — the robust fallback for selections
  // that cross inline formatting or block boundaries.
  function splitRangeIntoWords(src, start, end, fences) {
    const inserts = [];
    const re = /[A-Za-z0-9][A-Za-z0-9''\-]*/g;
    const sub = src.slice(start, end);
    let m;
    while ((m = re.exec(sub)) !== null) {
      const s = start + m.index, e = s + m[0].length;
      if (!inAnyRange(s, fences)) inserts.push({ type: 'pair', start: s, end: e });
    }
    return inserts;
  }

  // The block (paragraph) containing [start,end], bounded by blank lines.
  function blockBounds(src, start, end) {
    let bs = src.lastIndexOf('\n\n', start);
    bs = bs < 0 ? 0 : bs + 2;
    let be = src.indexOf('\n\n', end);
    be = be < 0 ? src.length : be;
    return [bs, be];
  }

  // Inline emphasis/code/strike spans in a block (approximate; common cases).
  function emphasisSpans(src, bs, be) {
    const text = src.slice(bs, be);
    const spans = [];
    const pats = [/\*\*\*[\s\S]+?\*\*\*/g, /\*\*[\s\S]+?\*\*/g, /(?<!\*)\*(?!\*)[^*\n]+?\*/g, /__[\s\S]+?__/g, /(?<!_)_(?!_)[^_\n]+?_/g, /`[^`\n]+?`/g, /~~[\s\S]+?~~/g];
    for (const re of pats) { let m; while ((m = re.exec(text)) !== null) spans.push([bs + m.index, bs + m.index + m[0].length]); }
    return spans;
  }

  // If a selection boundary falls INSIDE an emphasis span (e.g. selecting the
  // visible word "Harness" lands inside `**Harness**`), expand it outward to the
  // span edges so the highlighted text has balanced markup and can be rendered
  // as one contiguous highlight instead of fragmenting into words.
  function expandToBalanced(src, start, end) {
    const [bs, be] = blockBounds(src, start, end);
    const spans = emphasisSpans(src, bs, be);
    let s = start, e = end;
    for (const [ss, se] of spans) {
      if (ss < s && s < se) s = ss;
      if (ss < e && e < se) e = se;
    }
    return [s, e];
  }

  function buildCandidates(src, target, fences) {
    const cands = [];
    if (target.type === 'point') {
      const f = fenceContaining(target.pos, fences);
      if (f) {
        cands.push({ kind: 'block', inserts: [{ type: 'blockComment', pos: f[0] }] });
      } else {
        cands.push({ kind: 'point', inserts: [{ type: 'point', pos: target.pos }] });
        // fallback: if the exact caret would break (e.g. inside a list marker),
        // attach the comment to the start of the caret's line.
        const ls = src.lastIndexOf('\n', target.pos - 1) + 1;
        cands.push({ kind: 'line', inserts: [{ type: 'blockComment', pos: ls }] });
      }
      return cands;
    }
    const touched = fences.filter(([s, e]) => target.start < e && target.end > s);
    // Expand each block segment's boundaries out of any emphasis they bisect.
    const blockSegs = splitRangeIntoSegments(src, target.start, target.end, fences)
      .map(([s, e]) => expandToBalanced(src, s, e))
      .map(([s, e]) => ({ type: 'pair', start: s, end: e }));
    const wordSegs = splitRangeIntoWords(src, target.start, target.end, fences);
    if (touched.length) {
      const blocks = touched.map(([s]) => ({ type: 'blockComment', pos: s }));
      if (blockSegs.length) cands.push({ kind: 'split+block', inserts: blockSegs.concat(blocks) });
      if (wordSegs.length) cands.push({ kind: 'word+block', inserts: wordSegs.concat(blocks) });
      cands.push({ kind: 'block', inserts: blocks });
    } else {
      // Contiguous whole-range first (nicest) — boundaries snapped out of any
      // emphasis span — then per-block, then per-word as a last resort.
      const [es, ee] = expandToBalanced(src, target.start, target.end);
      cands.push({ kind: 'inline', inserts: [{ type: 'pair', start: es, end: ee }] });
      if (es !== target.start || ee !== target.end) {
        cands.push({ kind: 'inline', inserts: [{ type: 'pair', start: target.start, end: target.end }] });
      }
      const trimmedOrMulti = blockSegs.length > 1 ||
        (blockSegs.length === 1 && (blockSegs[0].start !== target.start || blockSegs[0].end !== target.end));
      if (trimmedOrMulti) cands.push({ kind: 'split', inserts: blockSegs });
      if (wordSegs.length) cands.push({ kind: 'word-split', inserts: wordSegs });
    }
    return cands;
  }

  function analyzeTarget(src, target, md) {
    const fences = codeFenceRanges(src);
    const candidates = buildCandidates(src, target, fences);
    for (const c of candidates) {
      if (!c.inserts || !c.inserts.length) continue;
      if (!md) return { supported: true, kind: c.kind, inserts: c.inserts, reason: '' };
      const annotated = applyInserts(src, c.inserts, 'x');
      if (isStructurePreserved(md, src, annotated)) {
        return { supported: true, kind: c.kind, inserts: c.inserts, reason: '' };
      }
    }
    // Last resort for ranges: partial per-word — keep only the word runs that
    // individually preserve structure (drops tokens like a list ordinal that
    // can't be wrapped), so a messy selection still annotates what it can.
    if (md && target.type === 'range') {
      const words = splitRangeIntoWords(src, target.start, target.end, fences);
      const okWords = words.filter(w => isStructurePreserved(md, src, applyInserts(src, [w], 'x')));
      if (okWords.length && isStructurePreserved(md, src, applyInserts(src, okWords, 'x'))) {
        return { supported: true, kind: 'word-partial', inserts: okWords, reason: '' };
      }
    }
    return { supported: false, kind: 'unsupported', inserts: [], reason: 'Annotating here would break the document formatting.' };
  }

  // Build annotated source from inserts. The 'pair' inserts form ONE group that
  // shares a single comment: every pair becomes a highlight {== text ==}, and the
  // LAST one (rightmost) also gets the {>> comment <<} badge. point/blockComment
  // inserts each emit their own comment. Applied right-to-left so offsets stay valid.
  function applyInserts(src, inserts, comment) {
    const pairs = inserts.filter(i => i.type === 'pair');
    const lastPairStart = pairs.length ? Math.max.apply(null, pairs.map(p => p.start)) : -1;
    const ordered = inserts.slice().sort((a, b) => posOf(b) - posOf(a));
    let out = src;
    for (const ins of ordered) {
      if (ins.type === 'pair') {
        const text = out.slice(ins.start, ins.end);
        const rep = ins.start === lastPairStart
          ? '{== ' + text + ' ==}{>> ' + comment + ' <<}'
          : '{== ' + text + ' ==}';
        out = out.slice(0, ins.start) + rep + out.slice(ins.end);
      } else if (ins.type === 'blockComment') {
        out = out.slice(0, ins.pos) + '{>> ' + comment + ' <<}\n' + out.slice(ins.pos);
      } else {
        out = out.slice(0, ins.pos) + '{>> ' + comment + ' <<}' + out.slice(ins.pos);
      }
    }
    return out;
  }

  function posOf(ins) {
    return ins.type === 'pair' ? ins.start : ins.pos;
  }

  function applyAnnotation(src, target, comment, md) {
    const r = analyzeTarget(src, target, md);
    if (!r.supported) return null;
    return applyInserts(src, r.inserts, comment);
  }

  return {
    CM_ANY,
    escapeHtml,
    codeFenceRanges,
    inAnyRange,
    scanAnnotations,
    deleteGroup,
    acceptGroup,
    suggestEdit,
    docZone,
    updateGroup,
    getGroupComment,
    preprocessCriticMarkup,
    annHtml,
    configureMd,
    renderAnnotated,
    stripAnnotationHtml,
    normalizeHtml,
    isStructurePreserved,
    analyzeTarget,
    applyInserts,
    applyAnnotation,
  };
});
