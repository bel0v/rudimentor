// THROWAWAY SPIKE — thin AudioWorklet wrapper around ProbeEngine.
// Runs on the audio rendering thread; the main thread never touches samples.
import { ProbeEngine } from './dsp.js';

class ProbeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new ProbeEngine(sampleRate, (msg, transfer) => this.port.postMessage(msg, transfer));
    this.port.onmessage = (ev) => this.engine.handle(ev.data);
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const outs = outputs[0];
    this.engine.processBlock(inp, outs[0]);
    for (let c = 1; c < outs.length; c++) outs[c].set(outs[0]);
    return true;
  }
}
registerProcessor('probe', ProbeProcessor);
