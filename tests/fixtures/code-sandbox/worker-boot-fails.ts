// A sandbox thread that dies before saying it is ready: the shape of a missing WASM file or a
// broken install, which the host must report as ITS failure and not as the snippet's.
throw new Error("boot failed on purpose");
