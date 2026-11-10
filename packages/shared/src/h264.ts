// Raw H.264 (Annex B, the way `screenrecord --output-format=h264` writes it) cut into NAL units,
// for the phone mirror: the daemon keeps the last keyframe for new viewers, the web decodes it.

const START = new Uint8Array([0, 0, 0, 1])

export class AnnexB {
  private buf = new Uint8Array(0)
  // where the current unit's 00 00 01 is; -1 before the first one
  private cur = -1
  private from = 0

  // the NAL units this chunk completed, each with a 4-byte start code
  push(chunk: Uint8Array): Uint8Array[] {
    const b = new Uint8Array(this.buf.length + chunk.length)
    b.set(this.buf)
    b.set(chunk, this.buf.length)
    const out: Uint8Array[] = []
    for (let i = this.cur < 0 ? this.from : Math.max(this.from, this.cur + 3); i + 2 < b.length; i++) {
      if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) continue
      if (this.cur >= 0) {
        const nal = trim(b.subarray(this.cur + 3, i))
        if (nal.length) out.push(withStart(nal))
      }
      this.cur = i
      i += 2
    }
    if (this.cur > 0) {
      this.buf = b.slice(this.cur)
      this.cur = 0
    } else this.buf = this.cur < 0 ? b.slice(Math.max(0, b.length - 2)) : b
    this.from = Math.max(0, this.buf.length - 2)
    return out
  }
}

// the zero bytes before the next start code belong to it
function trim(nal: Uint8Array): Uint8Array {
  let end = nal.length
  while (end > 0 && nal[end - 1] === 0) end--
  return nal.subarray(0, end)
}

function withStart(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length + 4)
  out.set(START)
  out.set(nal, 4)
  return out
}

// the NAL type of a unit that starts with a 4-byte start code
export const nalType = (nal: Uint8Array): number => (nal[4] ?? 0) & 0x1f

// a slice that starts a new picture (first_mb_in_slice is 0)
export const startsPicture = (nal: Uint8Array): boolean => {
  const t = nalType(nal)
  return (t === 1 || t === 5) && ((nal[5] ?? 0) & 0x80) !== 0
}

// "avc1.PPCCLL" for VideoDecoder, from an SPS unit
export const avcCodec = (sps: Uint8Array): string => `avc1.${[sps[5], sps[6], sps[7]].map((x) => (x ?? 0).toString(16).padStart(2, '0')).join('')}`
