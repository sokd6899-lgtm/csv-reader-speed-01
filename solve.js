// Fast drop-in replacement for csv-reader 1.0.0 (make.fun's reference CSV reader).
//
// run(input) returns exactly the same {columns, rows, errors} as csv-reader 1.0.0's readCsv
// for every input {text, header} — same records, same broken-row policy, same error objects
// in the same order — but reads the text with slice-based scanning instead of one character
// at a time:
//
//   - a record that sits on one physical line with no quotes and no stray CRs is split with
//     String.prototype.split(',') after one tight cleanliness scan of the line;
//   - an unquoted field is scanned by char codes up to its delimiter and sliced out whole;
//   - a quoted field jumps from quote to quote with indexOf, banking whole segments; only a
//     segment holding a CR is rebuilt character by character (CR/CRLF inside quotes read as
//     LF), exactly as the reference reads it.
//
// The semantics follow the reference point for point: a leading U+FEFF is dropped; records
// end at LF or CRLF and characterless lines are no records; a CR not followed by LF outside
// quotes is dropped (stray_cr); a quoted field runs to the next undoubled quote, "" inside
// it is one quote, and what follows the closing quote up to the next comma or line break is
// appended as it stands (quote_junk, when anything was appended); a quote that never closes
// is a literal character and the text after it is read again as an unquoted field
// (unterminated_quote); columns is the first record when header is true, else null; rows are
// padded with "" (short_row) or cut (long_row) to the first record's width; each error is
// {code, line, row} with line the 1-based line its record starts on (every LF, CRLF and lone
// CR inside a quoted field counted) and row its record's index in rows (null for the header).

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

  // Reads unquoted characters onto `initial` up to the next comma or line break, slicing whole
  // runs at a time: a CR not followed by LF is dropped (stray_cr). Sets fValue/fEnded/fAdded,
  // fAdded counting the characters this call kept (what quote_junk is judged by).
  function parseUnquoted(initial) {
    let acc = initial;
    let added = 0;
    let segStart = pos;
    let p = pos;
    while (p < len) {
      const c = text.charCodeAt(p);
      if (c === 44) { // ','
        added += p - segStart;
        fValue = acc + text.slice(segStart, p);
        fEnded = COMMA;
        fAdded = added;
        pos = p + 1;
        return;
      }
      if (c === 10) { // LF
        added += p - segStart;
        fValue = acc + text.slice(segStart, p);
        fEnded = LINE_BREAK;
        fAdded = added;
        pos = p + 1;
        line += 1;
        return;
      }
      if (c === 13) { // CR
        if (text.charCodeAt(p + 1) === 10) { // CRLF
          added += p - segStart;
          fValue = acc + text.slice(segStart, p);
          fEnded = LINE_BREAK;
          fAdded = added;
          pos = p + 2;
          line += 1;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        acc += text.slice(segStart, p);
        added += p - segStart;
        p += 1;
        segStart = p;
        continue;
      }
      p += 1;
    }
    added += len - segStart;
    fValue = acc + text.slice(segStart, len);
    fEnded = END;
    fAdded = added;
    pos = len;
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
      const rIdx = text.indexOf('\r', segStart);
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
        let nIdx = text.indexOf('\n', segStart);
        while (nIdx !== -1 && nIdx < q) {
          l += 1;
          nIdx = text.indexOf('\n', nIdx + 1);
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

    // Fast path: the record sits on one physical line holding no quote and no stray CR, so
    // it is the line split at its commas. (A quote anywhere on the line, or a CR that is not
    // the CR of the closing CRLF, sends the record to the field-by-field reader below.)
    {
      let scan = pos;
      let clean = true;
      let contentEnd = -1;
      let nextPos = -1;
      while (scan < len) {
        const c = text.charCodeAt(scan);
        if (c === 10) {
          contentEnd = scan;
          nextPos = scan + 1;
          break;
        }
        if (c === 34) {
          clean = false;
          break;
        }
        if (c === 13) {
          if (text.charCodeAt(scan + 1) === 10) {
            contentEnd = scan;
            nextPos = scan + 2;
          } else {
            clean = false;
          }
          break;
        }
        scan += 1;
      }
      if (clean) {
        if (contentEnd === -1) {
          contentEnd = len;
          nextPos = len;
        }
        fields = text.slice(pos, contentEnd).split(',');
        if (nextPos > contentEnd) line += 1;
        pos = nextPos;
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
