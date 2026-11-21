// Fast drop-in replacement for csv-reader 1.0.0 (make.fun's reference CSV reader) — v2.
//
// run(input) returns exactly the same {columns, rows, errors} as csv-reader 1.0.0's readCsv
// for every input {text, header} — same records, same broken-row policy, same error objects
// in the same order. Where v1 walked the text character by character in JavaScript, v2 lets
// the engine's native indexOf do the walking:
//
//   - three monotonic "next occurrence" cursors (for '"', CR and LF) answer "where is the
//     next special character at or after p" in amortised O(1) indexOf scans over the whole
//     parse — a naive indexOf per line or per field would rescan to the end of the text
//     whenever the character is rare (few CRs in an LF file, no quotes in a clean stretch),
//     which is quadratic; the cursors never scan any stretch twice;
//   - a record whose physical line holds no quote and no stray CR (asked of the cursors, not
//     of a per-character scan) is sliced out and split with String.prototype.split(',');
//   - an unquoted field is read by bounded indexOf jumps: the field cannot cross the next
//     LF, so the comma search is bounded by the line end and the CR search goes through the
//     cursor; whole runs are sliced, only stray CRs are stepped over one by one;
//   - a quoted field still jumps from quote to quote with indexOf, but its "does this
//     segment hold a CR / how many LFs" questions go through the cursors too, instead of an
//     unbounded indexOf('\r') per segment (in a file with few CRs that scan averages half
//     the CR gap — thousands of characters — per quoted segment).
//
// The semantics follow the reference point for point: a leading U+FEFF is dropped; records
// end at LF or CRLF and characterless lines are no records; a CR not followed by LF outside
// quotes is dropped (stray_cr); a quoted field runs to the next undoubled quote, "" inside
// it is one quote, each CRLF or lone CR inside it is read as one LF, and what follows the
// closing quote up to the next comma or line break is appended as it stands (quote_junk,
// when anything was appended); a quote that never closes is a literal character and the text
// after it is read again as an unquoted field (unterminated_quote); columns is the first
// record when header is true, else null; rows are padded with "" (short_row) or cut
// (long_row) to the first record's width; each error is {code, line, row} with line the
// 1-based line its record starts on (every LF, CRLF and lone CR inside a quoted field
// counted) and row its record's index in rows (null for the header).

/** How a field ended: at a comma (the record goes on), at a line break or at the text's end. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field parsers report through these, so no result object is allocated per field.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // A next-occurrence cursor for one character: next(p) is the first index >= p at which
  // the character occurs, or -1. The cursor remembers the first occurrence at or after
  // `from`; a query at or after `from` that the remembered occurrence answers costs
  // nothing, and any other query costs one indexOf from the query point — so over a whole
  // parse the scans never overlap (a query that moves backwards, as the unterminated-quote
  // re-read does, simply recomputes from there).
  function makeCursor(ch) {
    let idx = -2; // the remembered occurrence (-2: none computed yet, -1: none at or after `from`)
    let from = 0; // the position the remembered occurrence was computed from
    return function next(p) {
      if (idx !== -2 && p >= from && (idx === -1 || idx >= p)) return idx;
      idx = text.indexOf(ch, p);
      from = p;
      return idx;
    };
  }
  const nextQuote = makeCursor('"');
  const nextCR = makeCursor('\r');
  const nextLF = makeCursor('\n');
  const nextComma = makeCursor(',');

  // Reads unquoted characters onto `initial` up to the next comma or line break, slicing
  // whole runs at a time: a CR not followed by LF is dropped (stray_cr). Sets
  // fValue/fEnded/fAdded, fAdded counting the characters this call kept (what quote_junk
  // is judged by). The field ends at whichever of the three delimiter cursors points
  // first; every search goes through a cursor, so no stretch of text is ever rescanned.
  function parseUnquoted(initial) {
    let acc = initial;
    let added = 0;
    let p = pos;
    for (;;) {
      const cIdx = nextComma(p);
      const lIdx = nextLF(p);
      const rIdx = nextCR(p);
      // The earliest delimiter at or after p; ties are impossible (distinct characters),
      // except that a CRLF's CR sits one before its LF and so wins, as it should.
      if (cIdx !== -1 && (lIdx === -1 || cIdx < lIdx) && (rIdx === -1 || cIdx < rIdx)) {
        // The field ends at the comma.
        added += cIdx - p;
        fValue = acc + text.slice(p, cIdx);
        fEnded = COMMA;
        fAdded = added;
        pos = cIdx + 1;
        return;
      }
      if (rIdx !== -1 && (lIdx === -1 || rIdx < lIdx)) {
        if (text.charCodeAt(rIdx + 1) === 10) {
          // The CR of a CRLF: the field ends, the record ends.
          added += rIdx - p;
          fValue = acc + text.slice(p, rIdx);
          fEnded = LINE_BREAK;
          fAdded = added;
          pos = rIdx + 2;
          line += 1;
          return;
        }
        // A stray CR: dropped, with its error; the field reads on after it.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        acc += text.slice(p, rIdx);
        added += rIdx - p;
        p = rIdx + 1;
        continue;
      }
      if (lIdx !== -1) {
        // The field ends at the LF.
        added += lIdx - p;
        fValue = acc + text.slice(p, lIdx);
        fEnded = LINE_BREAK;
        fAdded = added;
        pos = lIdx + 1;
        line += 1;
        return;
      }
      // No delimiter left: the field runs to the text's end.
      added += len - p;
      fValue = acc + text.slice(p, len);
      fEnded = END;
      fAdded = added;
      pos = len;
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function parseQuoted() {
    const open = pos;
    const openLine = line;
    let p = open + 1;
    let segStart = p;
    let value = null; // null until a doubled quote banks a first segment
    let l = line; // the line count, committed only when the field really closes
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read
        // again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        parseUnquoted('"');
        return;
      }
      // The segment text[segStart, q): verbatim unless it holds a CR, since each CRLF or
      // lone CR inside quotes is read as one LF (and counts one line, as each LF does).
      let seg;
      const rIdx = nextCR(segStart);
      if (rIdx !== -1 && rIdx < q) {
        let built = '';
        let i = segStart;
        while (i < q) {
          const c = text.charCodeAt(i);
          if (c === 13) {
            built += '\n';
            l += 1;
            i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
          } else {
            if (c === 10) l += 1;
            built += text[i];
            i += 1;
          }
        }
        seg = built;
      } else {
        let nIdx = nextLF(segStart);
        while (nIdx !== -1 && nIdx < q) {
          l += 1;
          nIdx = nextLF(nIdx + 1);
        }
        seg = text.slice(segStart, q);
      }
      if (text.charCodeAt(q + 1) === 34) { // a doubled quote: one literal quote, read on
        value = (value === null ? seg : value + seg) + '"';
        p = q + 2;
        segStart = p;
        continue;
      }
      // The closing quote.
      value = value === null ? seg : value + seg;
      line = l;
      pos = q + 1;
      if (pos >= len) {
        fValue = value;
        fEnded = END;
        fAdded = 0;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = 0;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = 0;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or
      // line break (quote_junk, when the field ends, if anything was appended).
      parseUnquoted(value);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields = null;
    let lastQuoted = false;

    // Fast path: the record sits on one physical line holding no quote and no stray CR
    // (the cursors answer both, and the line end is one native indexOf), so it is the
    // line split at its commas.
    {
      const nl = text.indexOf('\n', pos);
      const lineEnd = nl === -1 ? len : nl;
      let contentEnd = lineEnd;
      if (nl !== -1 && contentEnd > pos && text.charCodeAt(contentEnd - 1) === 13) {
        contentEnd -= 1; // the CR of the closing CRLF is not content
      }
      const q = nextQuote(pos);
      const r = nextCR(pos);
      if ((q === -1 || q >= lineEnd) && (r === -1 || r >= contentEnd)) {
        fields = text.slice(pos, contentEnd).split(',');
        if (nl !== -1) line += 1;
        pos = nl === -1 ? len : nl + 1;
      }
    }

    if (fields === null) {
      fields = [];
      let ended;
      do {
        lastQuoted = text.charCodeAt(pos) === 34;
        if (lastQuoted) parseQuoted();
        else parseUnquoted('');
        fields.push(fValue);
        ended = fEnded;
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
