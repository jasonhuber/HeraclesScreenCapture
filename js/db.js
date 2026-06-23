import {
  DB_NAME,
  DB_VERSION,
  HANDLE_STORE,
  HANDLE_KEY,
  ASSET_STORE,
  ORIGINAL_STORE,
  ANNOTATION_STORE,
  EDITOR_SESSION_STORE
} from "./constants.js";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;

      [HANDLE_STORE, ASSET_STORE, ORIGINAL_STORE, ANNOTATION_STORE, EDITOR_SESSION_STORE].forEach((storeName) => {
        if (!database.objectStoreNames.contains(storeName)) {
          database.createObjectStore(storeName);
        }
      });
    });

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function withStore(storeName, mode, callback) {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);

    let settled = false;

    transaction.addEventListener("complete", () => {
      if (!settled) {
        resolve(undefined);
      }

      database.close();
    });

    transaction.addEventListener("error", () => {
      database.close();
      reject(transaction.error);
    });

    callback(store, (value) => {
      settled = true;
      resolve(value);
    });
  });
}

export async function storeHandle(handle) {
  await withStore(HANDLE_STORE, "readwrite", (store) => {
    store.put(handle, HANDLE_KEY);
  });
}

export async function getStoredHandle() {
  return withStore(HANDLE_STORE, "readonly", (store, resolve) => {
    const request = store.get(HANDLE_KEY);
    request.addEventListener("success", () => resolve(request.result || null));
    request.addEventListener("error", () => resolve(null));
  });
}

export async function deleteHandle() {
  await withStore(HANDLE_STORE, "readwrite", (store) => {
    store.delete(HANDLE_KEY);
  });
}

function isQuotaError(error) {
  return error && (error.name === "QuotaExceededError" || /quota/i.test(error.message || ""));
}

function rethrowStorageError(error) {
  if (isQuotaError(error)) {
    throw new Error(
      "Out of local storage for screenshots. Export and start a new run, delete some steps, or lower the image quality/size in Settings."
    );
  }

  throw error;
}

export async function storeCaptureAsset(captureId, blob) {
  try {
    await withStore(ASSET_STORE, "readwrite", (store) => {
      store.put(blob, captureId);
    });
  } catch (error) {
    rethrowStorageError(error);
  }
}

export async function getCaptureAsset(captureId) {
  return withStore(ASSET_STORE, "readonly", (store, resolve) => {
    const request = store.get(captureId);
    request.addEventListener("success", () => resolve(request.result || null));
    request.addEventListener("error", () => resolve(null));
  });
}

export async function deleteCaptureAsset(captureId) {
  await withStore(ASSET_STORE, "readwrite", (store) => {
    store.delete(captureId);
  });
}

export async function storeCaptureOriginal(captureId, blob) {
  try {
    await withStore(ORIGINAL_STORE, "readwrite", (store) => {
      store.put(blob, captureId);
    });
  } catch (error) {
    rethrowStorageError(error);
  }
}

export async function getCaptureOriginal(captureId) {
  return withStore(ORIGINAL_STORE, "readonly", (store, resolve) => {
    const request = store.get(captureId);
    request.addEventListener("success", () => resolve(request.result || null));
    request.addEventListener("error", () => resolve(null));
  });
}

export async function storeCaptureAnnotations(captureId, data) {
  await withStore(ANNOTATION_STORE, "readwrite", (store) => {
    store.put(data, captureId);
  });
}

export async function getCaptureAnnotations(captureId) {
  return withStore(ANNOTATION_STORE, "readonly", (store, resolve) => {
    const request = store.get(captureId);
    request.addEventListener("success", () => resolve(request.result || null));
    request.addEventListener("error", () => resolve(null));
  });
}

export async function putEditorSession(session) {
  await withStore(EDITOR_SESSION_STORE, "readwrite", (store) => {
    store.put(session, session.sessionId);
  });
}

export async function getEditorSession(sessionId) {
  return withStore(EDITOR_SESSION_STORE, "readonly", (store, resolve) => {
    const request = store.get(sessionId);
    request.addEventListener("success", () => resolve(request.result || null));
    request.addEventListener("error", () => resolve(null));
  });
}

export async function deleteEditorSession(sessionId) {
  await withStore(EDITOR_SESSION_STORE, "readwrite", (store) => {
    store.delete(sessionId);
  });
}

export async function deleteCaptureData(captureId) {
  await deleteCaptureAsset(captureId);

  await withStore(ORIGINAL_STORE, "readwrite", (store) => {
    store.delete(captureId);
  });

  await withStore(ANNOTATION_STORE, "readwrite", (store) => {
    store.delete(captureId);
  });
}
