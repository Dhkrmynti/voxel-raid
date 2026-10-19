// Compact binary encoding of the per-tick inputs a run was played with.
// Shared by the browser (recording) and the server (verification by re-simulation).
//
// Each tick is one flags byte followed only by the fields that changed:
//   bit 0 fire · bit 1 jump · bit 2 dash · bit 3 reload
//   bit 4 → mx, mz as int8 (×100)          bit 5 → weapon as uint8
//   bit 6 → Δyaw, Δpitch as zigzag varints (units of 1e-4 rad)

const MAGIC = [0x56, 0x52, 0x01]; // "VR" + format version
const AIM_SCALE = 1e4;
const STICK_SCALE = 100;

const zigzag = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);
const unzigzag = (z) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

export class ReplayWriter {
  constructor() {
    this.buf = new Uint8Array(4096);
    this.len = 0;
    this.ticks = 0;
    this.prev = { mx: 0, mz: 0, yaw: 0, pitch: 0 };
    for (const b of MAGIC) this.byte(b);
  }

  byte(b) {
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = b;
  }

  varint(n) {
    let z = zigzag(n);
    while (z >= 0x80) {
      this.byte((z % 0x80) | 0x80);
      z = Math.floor(z / 0x80);
    }
    this.byte(z);
  }

  /** Records the input exactly as it was handed to Sim.step(). */
  push(input) {
    const mx = Math.round(input.mx * STICK_SCALE);
    const mz = Math.round(input.mz * STICK_SCALE);
    const yaw = Math.round(input.yaw * AIM_SCALE);
    const pitch = Math.round(input.pitch * AIM_SCALE);
    const moved = mx !== this.prev.mx || mz !== this.prev.mz;
    const aimed = yaw !== this.prev.yaw || pitch !== this.prev.pitch;
    const weapon = input.weapon >= 0;
    this.byte(
      (input.fire ? 1 : 0) |
        (input.jump ? 2 : 0) |
        (input.dash ? 4 : 0) |
        (input.reload ? 8 : 0) |
        (moved ? 16 : 0) |
        (weapon ? 32 : 0) |
        (aimed ? 64 : 0),
    );
    if (moved) {
      this.byte(mx & 0xff);
      this.byte(mz & 0xff);
    }
    if (weapon) this.byte(input.weapon);
    if (aimed) {
      this.varint(yaw - this.prev.yaw);
      this.varint(pitch - this.prev.pitch);
    }
    this.prev = { mx, mz, yaw, pitch };
    this.ticks++;
  }

  bytes() {
    return this.buf.slice(0, this.len);
  }
}

/**
 * Decodes a replay back into Sim inputs. Throws on malformed data.
 * @param {Uint8Array} bytes
 * @param {number} maxTicks refuse replays longer than this
 */
export function decodeReplay(bytes, maxTicks = Infinity) {
  let i = 0;
  const read = () => {
    if (i >= bytes.length) throw new Error('Replay terpotong.');
    return bytes[i++];
  };
  const readVarint = () => {
    let z = 0;
    let mul = 1;
    for (let n = 0; n < 6; n++) {
      const b = read();
      z += (b & 0x7f) * mul;
      if (b < 0x80) return unzigzag(z);
      mul *= 0x80;
    }
    throw new Error('Replay rusak.');
  };
  const int8 = (b) => (b > 127 ? b - 256 : b);

  for (const m of MAGIC) if (read() !== m) throw new Error('Format replay tidak dikenal.');
  const inputs = [];
  let mx = 0;
  let mz = 0;
  let yaw = 0;
  let pitch = 0;
  while (i < bytes.length) {
    if (inputs.length >= maxTicks) throw new Error('Replay terlalu panjang.');
    const flags = read();
    if (flags & 128) throw new Error('Replay rusak.');
    if (flags & 16) {
      mx = int8(read());
      mz = int8(read());
      if (Math.abs(mx) > STICK_SCALE || Math.abs(mz) > STICK_SCALE) throw new Error('Replay rusak.');
    }
    const weapon = flags & 32 ? read() : -1;
    if (flags & 64) {
      yaw += readVarint();
      pitch += readVarint();
    }
    inputs.push({
      mx: mx / STICK_SCALE,
      mz: mz / STICK_SCALE,
      yaw: yaw / AIM_SCALE,
      pitch: pitch / AIM_SCALE,
      fire: !!(flags & 1),
      jump: !!(flags & 2),
      dash: !!(flags & 4),
      reload: !!(flags & 8),
      weapon,
    });
  }
  return inputs;
}
