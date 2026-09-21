import type { Readable, Writable } from "node:stream";
import process from "node:process";
import { BrokerClient } from "./broker-client.js";
import { bridgeConfigPath, ensureBridgeConfig, resolveBridgeConfigDirectory, type BridgeConfig, type BridgeConfigOptions } from "./config.js";
import { BRIDGE_METHODS, MAX_NATIVE_MESSAGE_BYTES } from "./constants.js";
import { ClipperBridgeError, asBridgeError } from "./errors.js";
import { ensureBrokerRunning } from "./ensure-broker.js";
import { NativeMessageDecoder, encodeNativeMessage } from "./native-framing.js";
import {
  assertProfileId,
  failureResponse,
  isRecord,
  isWireEvent,
  isWireRequest,
  isWireResponse,
  parseWireMessage,
  successResponse,
  type WireEvent,
  type WireMessage,
  type WireRequest,
} from "./wire.js";

export interface NativeHostOptions {
  config?: BridgeConfig;
  configOptions?: BridgeConfigOptions;
  input?: Readable;
  output?: Writable;
  ensureBroker?: (config: BridgeConfig, configDirectory: string) => Promise<void>;
  onDiagnostic?: (message: string) => void;
}

function outputMessage(output: Writable, message: WireMessage): void {
  output.write(encodeNativeMessage(message, MAX_NATIVE_MESSAGE_BYTES));
}

function helloProfile(request: WireRequest): string {
  return assertProfileId(request.profileId ?? (isRecord(request.params) ? request.params.profileId : undefined));
}

/**
 * Chromium runs this executable as a Native Messaging host. It only relays
 * framed messages to the private broker; it creates no business store and
 * never writes arbitrary browser data to disk.
 */
export async function runNativeHost(options: NativeHostOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const configOptions = options.configOptions ?? {};
  const config = options.config ?? await ensureBridgeConfig(configOptions);
  const configDirectory = resolveBridgeConfigDirectory(configOptions);
  const startBroker = options.ensureBroker ?? ((current, directory) => ensureBrokerRunning({ config: current, configDirectory: directory }));
  await startBroker(config, configDirectory);
  const broker = await BrokerClient.connect({ config, role: "native" });
  const decoder = new NativeMessageDecoder(MAX_NATIVE_MESSAGE_BYTES);
  let activeProfile: string | undefined;

  const sendError = (id: string, error: unknown, profileId?: string): void => {
    outputMessage(output, failureResponse(id, error, profileId));
  };

  const handle = async (raw: unknown): Promise<void> => {
    let message: WireMessage;
    try {
      message = parseWireMessage(raw);
    } catch (error) {
      const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : "invalid-message";
      sendError(id, error);
      return;
    }

    if (isWireRequest(message) && message.method === BRIDGE_METHODS.hello) {
      let profileId: string;
      try {
        profileId = helloProfile(message);
        if (activeProfile && activeProfile !== profileId) {
          throw new ClipperBridgeError("PROFILE_ROUTE_FORBIDDEN", "A Native Host process may only serve one browser profile.");
        }
        const result = await broker.request(BRIDGE_METHODS.hello, message.params, profileId);
        activeProfile = profileId;
        outputMessage(output, successResponse(message.id, result, profileId));
      } catch (error) {
        sendError(message.id, asBridgeError(error), message.profileId);
      }
      return;
    }

    if (!activeProfile) {
      if (isWireRequest(message)) sendError(message.id, new ClipperBridgeError("PROFILE_REQUIRED", "Send bridge.hello before other Native Messaging messages."));
      return;
    }
    if (message.profileId !== undefined && message.profileId !== activeProfile) {
      if (isWireRequest(message) || isWireResponse(message)) sendError(message.id, new ClipperBridgeError("PROFILE_ROUTE_FORBIDDEN", "The Native Host received a message for a different browser profile."), activeProfile);
      return;
    }
    if (isWireResponse(message)) {
      broker.sendMessage({ ...message, profileId: activeProfile });
      return;
    }
    if (isWireEvent(message)) {
      const event: WireEvent = { ...message, profileId: activeProfile };
      broker.sendMessage(event);
      return;
    }
    if (isWireRequest(message)) {
      sendError(message.id, new ClipperBridgeError("METHOD_FORBIDDEN", "The Native Host only accepts bridge.hello from the browser extension."), activeProfile);
    }
  };

  const forwardBrokerRequest = (request: WireRequest): void => {
    if (!activeProfile || request.profileId !== activeProfile) {
      /*
       * This should only be reachable during a disconnect/reconnect race. Do
       * not leave the broker relay hanging or route it to a different profile.
       */
      broker.sendMessage(
        failureResponse(
          request.id,
          new ClipperBridgeError(
            "BROWSER_UNAVAILABLE",
            "The Native Host has no matching connected browser profile for this request.",
          ),
          request.profileId,
        ),
      );
      return;
    }
    outputMessage(output, request);
  };
  broker.on("request", forwardBrokerRequest);

  await new Promise<void>((resolve) => {
    /*
     * The extension posts bridge.hello as soon as Native Messaging connects
     * and may post its first reply immediately after it. Serialize frames so
     * that a later response cannot race profile registration at the broker.
     */
    let serial = Promise.resolve();
    const onData = (chunk: Buffer | string) => {
      let frames: unknown[];
      try {
        frames = decoder.push(Buffer.from(chunk));
      } catch (error) {
        sendError("invalid-frame", error, activeProfile);
        broker.close();
        input.destroy();
        return;
      }
      for (const frame of frames) {
        serial = serial
          .then(() => handle(frame))
          .catch((error) => options.onDiagnostic?.(asBridgeError(error).code));
      }
    };
    const finish = () => {
      input.off("data", onData);
      broker.off("request", forwardBrokerRequest);
      broker.close();
      resolve();
    };
    input.on("data", onData);
    input.once("end", finish);
    input.once("close", finish);
    input.once("error", finish);
    broker.once("close", () => {
      // Browser reconnects through Chrome's normal Native Messaging lifecycle.
      // We do not queue/replay any request after this point.
      input.destroy();
    });
  });
}

export function nativeHostConfigPath(options: BridgeConfigOptions = {}): string {
  return bridgeConfigPath(options);
}
