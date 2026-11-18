// A conversion process wedged INSIDE WASM, the way a decoder loop would be: a module whose one export
// loops forever. Nothing running in this process can stop it; only the host's kill does.
await Bun.stdin.arrayBuffer();
const spin = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 115,
  112, 105, 110, 0, 0, 10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11,
]);
const instance = new WebAssembly.Instance(new WebAssembly.Module(spin), {});
(instance.exports.spin as () => void)();
