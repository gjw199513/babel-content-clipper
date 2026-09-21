import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

import type {
  AttachmentChunkRecord,
  AttachmentRecord,
  CaptureRecord,
  ClipperSettings,
  ExecutionEvent,
  JobRecord,
  ResultRecord,
} from "./types.js";
import { CORE_DATABASE_VERSION } from "./types.js";

export interface ReceiptRecord {
  readonly receiptKey: string;
  readonly profileId: string;
  readonly method: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly response: unknown;
  readonly createdAt: string;
}

export interface CleanupSnapshotRecord {
  readonly cleanupToken: string;
  readonly profileId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly captureRevisions: Readonly<Record<string, number>>;
  readonly relationFingerprints: Readonly<Record<string, string>>;
  readonly captureIds: readonly string[];
}

export interface MetaRecord {
  readonly key: string;
  readonly value: number | string;
}

export interface CaptureSourceContextRecord {
  readonly captureId: string;
  readonly profileId: string;
  readonly createdAt: string;
  readonly pageUrl?: string;
  readonly mediaUrl?: string;
}

export interface CoreDatabaseSchema extends DBSchema {
  captures: {
    key: string;
    value: CaptureRecord;
    indexes: {
      "by-profile-created": [string, string];
      "by-profile-source": [string, string];
      "by-profile-collection": [string, string];
    };
  };
  sourceContexts: {
    key: string;
    value: CaptureSourceContextRecord;
    indexes: {
      "by-profile": string;
    };
  };
  jobs: {
    key: string;
    value: JobRecord;
    indexes: {
      "by-capture": string;
      "by-profile-status": [string, string];
      "by-profile-created": [string, string];
    };
  };
  executionEvents: {
    key: string;
    value: ExecutionEvent;
    indexes: {
      "by-job": string;
      "by-capture": string;
      "by-profile-created": [string, string];
    };
  };
  results: {
    key: string;
    value: ResultRecord;
    indexes: {
      "by-job": string;
      "by-capture": string;
      "by-profile-completed": [string, string];
    };
  };
  attachments: {
    key: string;
    value: AttachmentRecord;
    indexes: {
      "by-profile": string;
      "by-capture": string;
      "by-job": string;
    };
  };
  attachmentChunks: {
    key: [string, number];
    value: AttachmentChunkRecord;
    indexes: {
      "by-attachment": string;
    };
  };
  settings: {
    key: string;
    value: ClipperSettings;
  };
  receipts: {
    key: string;
    value: ReceiptRecord;
    indexes: {
      "by-profile-created": [string, string];
    };
  };
  cleanupPreviews: {
    key: string;
    value: CleanupSnapshotRecord;
    indexes: {
      "by-profile": string;
    };
  };
  meta: {
    key: string;
    value: MetaRecord;
  };
}

export async function openClipperDatabase(
  databaseName: string,
): Promise<IDBPDatabase<CoreDatabaseSchema>> {
  return openDB<CoreDatabaseSchema>(databaseName, CORE_DATABASE_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const captures = database.createObjectStore("captures", { keyPath: "captureId" });
        captures.createIndex("by-profile-created", ["profileId", "createdAt"]);
        captures.createIndex("by-profile-source", ["profileId", "sourceKey"]);
        captures.createIndex("by-profile-collection", ["profileId", "collection"]);

        const jobs = database.createObjectStore("jobs", { keyPath: "jobId" });
        jobs.createIndex("by-capture", "captureId");
        jobs.createIndex("by-profile-status", ["profileId", "status"]);
        jobs.createIndex("by-profile-created", ["profileId", "createdAt"]);

        const events = database.createObjectStore("executionEvents", {
          keyPath: "eventId",
        });
        events.createIndex("by-job", "jobId");
        events.createIndex("by-capture", "captureId");
        events.createIndex("by-profile-created", ["profileId", "createdAt"]);

        const results = database.createObjectStore("results", { keyPath: "resultId" });
        results.createIndex("by-job", "jobId", { unique: true });
        results.createIndex("by-capture", "captureId");
        results.createIndex("by-profile-completed", ["profileId", "completedAt"]);

        const attachments = database.createObjectStore("attachments", {
          keyPath: "attachmentId",
        });
        attachments.createIndex("by-profile", "profileId");
        attachments.createIndex("by-capture", "captureId");
        attachments.createIndex("by-job", "jobId");

        const chunks = database.createObjectStore("attachmentChunks", {
          keyPath: ["attachmentId", "offset"],
        });
        chunks.createIndex("by-attachment", "attachmentId");

        database.createObjectStore("settings", { keyPath: "profileId" });

        const receipts = database.createObjectStore("receipts", { keyPath: "receiptKey" });
        receipts.createIndex("by-profile-created", ["profileId", "createdAt"]);

        const cleanupPreviews = database.createObjectStore("cleanupPreviews", {
          keyPath: "cleanupToken",
        });
        cleanupPreviews.createIndex("by-profile", "profileId");

        database.createObjectStore("meta", { keyPath: "key" });
      }
      if (oldVersion < 2) {
        const sourceContexts = database.createObjectStore("sourceContexts", { keyPath: "captureId" });
        sourceContexts.createIndex("by-profile", "profileId");
      }
    },
  });
}

export async function deleteClipperDatabase(databaseName: string): Promise<void> {
  await deleteDB(databaseName);
}
