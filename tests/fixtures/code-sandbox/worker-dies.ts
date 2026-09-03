// A sandbox thread that boots and then dies on the request: the shape of the interpreter giving up
// in a way its own error path did not catch. After `ready`, that is the snippet's abort.
declare var self: Worker;
self.onmessage = () => {
  throw new Error("interpreter gave up");
};
self.postMessage({ kind: "ready" });
