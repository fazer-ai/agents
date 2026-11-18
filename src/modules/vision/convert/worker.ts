// The thread one media conversion runs in, spawned per conversion by `runMediaConverter` (./index).
// It converts the bytes it is handed and answers once: the JPEG, transferred back, or the refusal as
// data, since an Error's class does not survive `postMessage`. Every decoder release happens in here,
// on the same paths as on the calling thread, before the answer is posted.
import {
  type ConversionReply,
  type ConversionRequest,
  convertInline,
  describeConversionFailure,
} from "./index";

declare var self: Worker;

self.onmessage = async (ev: MessageEvent<ConversionRequest>) => {
  const { id, bytes, limits } = ev.data;
  let reply: ConversionReply;
  try {
    reply = { ok: true, bytes: await convertInline(id, bytes, limits) };
  } catch (err) {
    reply = { ok: false, ...describeConversionFailure(err) };
  }
  self.postMessage(reply, reply.ok ? [reply.bytes] : []);
};
