// A conversion thread that takes the request and dies on it: the shape of a decoder failing in a
// way its own error path did not catch.
declare var self: Worker;
self.onmessage = () => {
  throw new Error("decoder gave up");
};
