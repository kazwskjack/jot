/*
Retained verbatim pure trace functions from @deepseek-ai/dsh-session 0.2.0-rc.2 lib/invariant.js.
Upstream: https://github.com/deepseek-ai/deepseek-harness (MIT).
Source SHA-256: 53066dc4945c0159fb5b48944b578a2d2d22f2f3bd5042599f2f6278edc84466.
The 0.2.1-rc.2 SDK removed the companion; these checks remain Jot replay policy, not a claim that the new SDK supplies them.

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
/** Load the official package-owned session invariant in an isolated read-only
 * context. The composition has no Agent, driver, model, tools or persistence. */
function createLegacyReplay({Context,Service,InvariantRegistry,sessionInvariant}){
 if(typeof Context!=='function'||typeof Service!=='function'||typeof InvariantRegistry!=='function'||typeof sessionInvariant?.apply!=='function')throw Error('native_invariant_replay_unavailable');
 return async function validateLog(view,{signal}={}){
  signal?.throwIfAborted();if(typeof view?.snapshotEvents!=='function')throw Error('native_invariant_log_invalid');
  const ctx=new Context();
  class ReadOnlySessionLog extends Service{constructor(scope){super(scope,'sessions');}list(){return [view];}}
  try{
   await ctx.plugin(ReadOnlySessionLog);signal?.throwIfAborted();
   await ctx.plugin(InvariantRegistry,{enabled:true,package_allowlist:['^@deepseek-ai/dsh-session$'],package_blocklist:[]});
   if(ctx.invariants.selected('@deepseek-ai/dsh-session')!==true)throw Error('native_invariant_replay_unavailable');
   await ctx.plugin(sessionInvariant);signal?.throwIfAborted();return {validated:true};
  }finally{await ctx.fiber.dispose();}
 };
}

/** New SDK structural replay plus retained pre-upgrade relational policy.
 * Session.create is detached: no Context, Agent, driver, tools or storage. */
export function createNativeInvariantReplay(options={}){
 if(options.Session===undefined)return createLegacyReplay(options);
 const {Session}=options;
 if(typeof Session?.create!=='function')throw Error('native_invariant_replay_unavailable');
 return async function validateLog(view,{signal}={}){
  signal?.throwIfAborted();
  if(typeof view?.snapshotEvents!=='function'||!Number.isSafeInteger(view.seq)||view.seq<0)throw Error('native_invariant_log_invalid');
  const events=view.snapshotEvents();
  if(!Array.isArray(events)||events.length!==view.seq)throw Error('native_invariant_log_invalid');
  // The SDK validates contiguous event envelopes, surfaces, headers and message
  // shapes. Never substitute its weaker fromRestore path or a projection tail.
  Session.create(view.id,events,view.header,view.inheritedEventCount);
  const trace={lastSeq:-1,openTurn:null,openStep:null,nextTurn:1,nextStep:1,pendingCalls:new Set()};
  const fail=reason=>{throw Error('native_invariant_log_invalid: '+reason);};
  for(const event of events){signal?.throwIfAborted();applyTransition(trace,validateEvent(trace,event,fail));}
  signal?.throwIfAborted();return {validated:true};
 };
}

function assertNever(value,subject){throw Error(subject+": "+String(value));}
/** Assert that a step-scoped event names the currently open turn and step. */
function requireOpenStep(trace, kind, turn, step, fail) {
	if (trace.openTurn !== turn || trace.openStep !== step) fail(`${kind} names turn ${turn}/step ${step} but open is turn ${trace.openTurn}/step ${trace.openStep}`);
}
/** Validate one candidate event without mutating the committed trace. */
function validateEvent(trace, event, fail) {
	if (event.seq <= trace.lastSeq) fail(`seq must strictly increase: saw ${event.seq} after ${trace.lastSeq}`);
	let openTurn = trace.openTurn;
	let openStep = trace.openStep;
	let nextTurn = trace.nextTurn;
	let nextStep = trace.nextStep;
	let pendingCalls = { kind: "none" };
	switch (event.type) {
		case "turn/start":
			if (trace.openTurn !== null) fail(`turn/start ${event.data.turn} while turn ${trace.openTurn} is still open`);
			if (event.data.turn !== trace.nextTurn) fail(`turn/start expected turn ${trace.nextTurn}, got ${event.data.turn}`);
			openTurn = event.data.turn;
			nextStep = 1;
			break;
		case "turn/end":
			if (trace.openTurn !== event.data.turn) fail(`turn/end ${event.data.turn} does not match open turn ${trace.openTurn}`);
			if (trace.openStep !== null) fail(`turn/end ${event.data.turn} while step ${trace.openStep} is still open`);
			openTurn = null;
			nextTurn += 1;
			break;
		case "step/start":
			if (trace.openTurn !== event.data.turn) fail(`step/start in turn ${event.data.turn} but open turn is ${trace.openTurn}`);
			if (trace.openStep !== null) fail(`step/start ${event.data.step} while step ${trace.openStep} is still open`);
			if (event.data.step !== trace.nextStep) fail(`step/start expected step ${trace.nextStep} in turn ${event.data.turn}, got ${event.data.step}`);
			openStep = event.data.step;
			break;
		case "developer/message":
			requireOpenStep(trace, "developer/message", event.data.turn, event.data.step, fail);
			break;
		case "step/end":
			requireOpenStep(trace, "step/end", event.data.turn, event.data.step, fail);
			pendingCalls = { kind: "clear" };
			openStep = null;
			nextStep += 1;
			break;
		case "assistant/attempt":
			requireOpenStep(trace, "assistant/attempt", event.data.turn, event.data.step, fail);
			break;
		case "assistant/message":
			requireOpenStep(trace, "assistant/message", event.data.turn, event.data.step, fail);
			break;
		case "tool/call":
			requireOpenStep(trace, "tool/call", event.data.turn, event.data.step, fail);
			pendingCalls = {
				kind: "add",
				callId: event.data.callId
			};
			break;
		case "tool/result": {
			if (event.surfaceOp !== "append") {
				if (trace.openTurn === null) fail("tool/result surface replacement appended outside any open turn");
				break;
			}
			requireOpenStep(trace, "tool/result", event.data.turn, event.data.step, fail);
			const callId = event.data.message.source.callId;
			const syntheticNotStarted = event.data.message.isError === true && event.data.error?.code === "TOOL_NOT_STARTED";
			if (!trace.pendingCalls.has(callId) && !syntheticNotStarted) fail(`tool/result for ${callId} with no prior tool/call in this step`);
			pendingCalls = {
				kind: "delete",
				callId
			};
			break;
		}
		case "system/message":
			requireOpenStep(trace, "system/message", event.data.turn, event.data.step, fail);
			break;
		case "user/message": break;
		case "session/end-seed": break;
		case "request/header":
		case "request/context":
			if (trace.openTurn === null) fail(`${event.type} appended outside any open turn (core execution events must be turn-enclosed)`);
			break;
		default: break;
	}
	return {
		scalars: {
			lastSeq: event.seq,
			openTurn,
			openStep,
			nextTurn,
			nextStep
		},
		pendingCalls
	};
}
/** Apply one already-validated transition after its event commits. */
function applyTransition(trace, transition) {
	Object.assign(trace, transition.scalars);
	switch (transition.pendingCalls.kind) {
		case "none": break;
		case "add":
			trace.pendingCalls.add(transition.pendingCalls.callId);
			break;
		case "delete":
			trace.pendingCalls.delete(transition.pendingCalls.callId);
			break;
		case "clear":
			trace.pendingCalls.clear();
			break;
		/* v8 ignore next -- validateEvent produces this closed transition union */
		default: assertNever(transition.pendingCalls, "session trace pending-call transition");
	}
}
