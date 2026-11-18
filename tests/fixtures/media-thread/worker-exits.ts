// A conversion thread that ends without answering: the shape of the runtime killing it (an
// allocation the WASM heap could not grow into).
declare var self: Worker;
self.onmessage = () => {
  process.exit(1);
};
