/**
 * Render untrusted text as a single terminal line, before measuring or styling it.
 * Never apply this to stored data, JSON, or application-owned ANSI sequences.
 * The BB plugin vendors this file to keep its distributable package self-contained.
 */
export function terminalText(value: string): string {
  let result = ""
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index)
    if (code === 0x1b) {
      code = value.charCodeAt(++index)
      // The 7-bit spellings of CSI, OSC, DCS, SOS, PM and APC.
      if (code >= 0x40 && code <= 0x5f) code += 0x40
      else {
        // Other ESC sequences: zero or more intermediates and a final byte.
        while (code >= 0x20 && code <= 0x2f) code = value.charCodeAt(++index)
        if (!(code >= 0x30 && code <= 0x7e)) index--
        continue
      }
    }
    if (code === 0x9b) {
      // Consume CSI through its final byte; incomplete sequences consume the tail.
      while (++index < value.length) {
        const next = value.charCodeAt(index)
        if (next >= 0x40 && next <= 0x7e) break
      }
    } else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      // String controls end with ST (7- or 8-bit), or BEL for OSC.
      while (++index < value.length) {
        const next = value.charCodeAt(index)
        if (next === 0x9c || (code === 0x9d && next === 0x07)) break
        if (next === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
          index++
          break
        }
      }
    } else if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      result += " "
    } else if (
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c || code === 0x200e || code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
    ) {
      // C0, DEL, C1 and Unicode Bidi_Control characters have no display role here.
    } else result += value[index]
  }
  return result
}
