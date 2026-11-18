// A conversion process that dies on the request: the shape of a decoder failing in a way its own
// error path did not catch.
await Bun.stdin.arrayBuffer();
throw new Error("decoder gave up");
