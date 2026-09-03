// A sandbox thread that boots and then never answers: the shape of an interrupt that never fires.
// The host's hard kill is the only thing that ends it.
declare var self: Worker;
self.onmessage = () => {
  // NOTE: Deliberately never replies.
};
self.postMessage({ kind: "ready" });
