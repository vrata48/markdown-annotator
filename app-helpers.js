/* Browser-independent application helpers. Kept as a classic UMD script so
 * the static app can load it directly and Node can exercise it in CI. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AnnotatorAppHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function decodePart(value) {
    try { return decodeURIComponent(value); } catch (_) { return value; }
  }

  function normalizeTypography(str) {
    const out = [];
    const map = [];
    let inSpace = false;
    let last = '';
    for (let i = 0; i < str.length; i++) {
      let c = str[i];
      if (c === '\u2018' || c === '\u2019' || c === '\u02bc') c = "'";
      else if (c === '\u201c' || c === '\u201d') c = '"';
      else if (c === '\u2013' || c === '\u2014') c = '-';
      else if (c === '\u2026') c = '.';
      else if (c === '\u00a0') c = ' ';
      if (/\s/.test(c)) {
        if (!inSpace) { out.push(' '); map.push(i); }
        inSpace = true;
        last = ' ';
        continue;
      }
      inSpace = false;
      if ((c === '-' || c === '.') && last === c) continue;
      out.push(c);
      map.push(i);
      last = c;
    }
    return { norm: out.join(''), map };
  }

  function stripMarkdownInline(value) {
    return value
      .replace(/\*\*\*(.*?)\*\*\*/g, '$1')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/`(.*?)`/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '');
  }

  function lcsLength(a, b) {
    if (!a || !b) return 0;
    const prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      let prevDiag = 0;
      for (let j = 1; j <= b.length; j++) {
        const temp = prev[j];
        if (a[i - 1] === b[j - 1]) prev[j] = prevDiag + 1;
        else prev[j] = Math.max(prev[j], prev[j - 1]);
        prevDiag = temp;
      }
    }
    return prev[b.length];
  }

  function findInSource(source, selectedText, beforeCtx, afterCtx) {
    const normalizedSel = selectedText.replace(/\r\n/g, '\n');
    const candidates = [];
    let pos = -1;
    while ((pos = source.indexOf(normalizedSel, pos + 1)) !== -1) {
      candidates.push({ start: pos, end: pos + normalizedSel.length, score: 0 });
    }
    const wrappers = [['**', '**'], ['*', '*'], ['__', '__'], ['_', '_'], ['`', '`'], ['~~', '~~'], ['***', '***']];
    for (const [open, close] of wrappers) {
      let at = -1;
      const wrapped = open + normalizedSel + close;
      while ((at = source.indexOf(wrapped, at + 1)) !== -1) {
        candidates.push({ start: at + open.length, end: at + open.length + normalizedSel.length, score: 1 });
      }
    }
    if (!candidates.length) {
      const selNorm = normalizeTypography(normalizedSel).norm.trim();
      const normalized = normalizeTypography(source);
      if (selNorm) {
        let at = -1;
        while ((at = normalized.norm.indexOf(selNorm, at + 1)) !== -1) {
          const endOut = at + selNorm.length;
          const end = endOut < normalized.map.length ? normalized.map[endOut] : source.length;
          candidates.push({ start: normalized.map[at], end, score: -1 });
        }
      }
    }
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    const before = stripMarkdownInline(beforeCtx).slice(-40);
    const after = stripMarkdownInline(afterCtx).slice(0, 40);
    for (const candidate of candidates) {
      const sourceBefore = stripMarkdownInline(source.slice(Math.max(0, candidate.start - 80), candidate.start)).slice(-40);
      const sourceAfter = stripMarkdownInline(source.slice(candidate.end, candidate.end + 80)).slice(0, 40);
      candidate.score += lcsLength(before, sourceBefore) + lcsLength(after, sourceAfter);
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  function folderChildren(entries) {
    const byName = (a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) ||
      String(a.name).localeCompare(String(b.name));
    const kept = (entries || []).filter(e => e && e.name &&
      !String(e.name).startsWith('.') && e.name !== 'node_modules' &&
      (e.kind === 'directory' || /\.(md|markdown|mdx|txt)$/i.test(e.name)));
    return kept.filter(e => e.kind === 'directory').sort(byName)
      .concat(kept.filter(e => e.kind !== 'directory').sort(byName));
  }

  function annotationGroups(items) {
    const byGroup = new Map();
    const groups = [];
    for (const item of items || []) {
      const label = item.comment || item.text2 || item.text || 'Annotation';
      const normalized = String(label).replace(/\s+/g, ' ').trim();
      if (byGroup.has(item.group)) {
        const existing = byGroup.get(item.group);
        if (item.comment) existing.label = normalized;
        continue;
      }
      const group = { group: item.group, kind: item.kind, label: normalized };
      byGroup.set(item.group, group);
      groups.push(group);
    }
    return groups;
  }

  // ── Shared sessions (collab.js) ──────────────────────────────────────────

  // The single contiguous edit turning `before` into `after`, or null when
  // they are equal: {index, remove, insert} in UTF-16 code units, which is
  // also how Y.Text counts. Every app mutation is one localized splice
  // (an annotation inserted, a group removed or accepted), so the
  // common-prefix/common-suffix span is exactly that splice. The span is
  // widened so it never starts or ends between the halves of a surrogate
  // pair: a lone surrogate would not survive the UTF-8 encoding of an update.
  function textDiff(before, after) {
    if (before === after) return null;
    const max = Math.min(before.length, after.length);
    let start = 0;
    while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
    if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
    let endBefore = before.length, endAfter = after.length;
    while (endBefore > start && endAfter > start &&
      before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) { endBefore--; endAfter--; }
    if (endBefore < before.length && isLowSurrogate(before.charCodeAt(endBefore))) { endBefore++; endAfter++; }
    return { index: start, remove: endBefore - start, insert: after.slice(start, endAfter) };
  }
  function isHighSurrogate(code) { return code >= 0xD800 && code <= 0xDBFF; }
  function isLowSurrogate(code) { return code >= 0xDC00 && code <= 0xDFFF; }

  // A share link carries the room id and the encryption key in the URL
  // fragment (never sent to any server): "#share=<room>.<key>", both base64url.
  const SHARE_PART = /^[A-Za-z0-9_-]{16,64}$/;
  function shareHash(room, key) { return '#share=' + room + '.' + key; }
  function parseShareHash(hash) {
    const m = /(?:^|[#&])share=([^&.]+)\.([^&]+)/.exec(String(hash || ''));
    if (!m || !SHARE_PART.test(m[1]) || !SHARE_PART.test(m[2])) return null;
    return { room: m[1], key: m[2] };
  }

  // Comments made in a shared session carry their author as plain text so the
  // file stays readable anywhere: "@Name: comment".
  function tagAuthor(name, comment) {
    const who = String(name || '').replace(/\s+/g, ' ').trim();
    const text = String(comment || '');
    if (!who) return text;
    return '@' + who + ': ' + text;
  }

  return {
    normalizeTypography,
    stripMarkdownInline,
    lcsLength,
    findInSource,
    annotationGroups,
    folderChildren,
    textDiff,
    shareHash,
    parseShareHash,
    tagAuthor,
  };
});
