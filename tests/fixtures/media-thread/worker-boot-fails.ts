// A conversion thread that dies while loading, before it can take a request: the shape of a broken
// install.
throw new Error("boot failed on purpose");
