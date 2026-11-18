// A conversion process whose answer is not one: a header that does not parse.
await Bun.stdin.arrayBuffer();
await Bun.write(Bun.stdout, "not a header\n");
