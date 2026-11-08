// The sandbox thread's entry: the interpreter side, on the wall clock.
import { serve } from "./code-sandbox.worker";

serve(Date.now);
