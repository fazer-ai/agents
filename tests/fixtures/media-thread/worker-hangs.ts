// A conversion thread that takes the request and never answers: the shape of a wedged decoder. The
// host's time budget is the only thing that ends it.
declare var self: Worker;
self.onmessage = () => {
  // NOTE: Deliberately never replies.
};
