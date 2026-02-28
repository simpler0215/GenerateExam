import { FirebaseOptions, getApp, getApps, initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

let appInitialized = false;

function getRequiredEnv(value: string | undefined, checkedKeys: string): string {
  if (value) {
    return value;
  }
  throw new Error(
    `Missing required Firebase environment variable. Checked: ${checkedKeys}`,
  );
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function getFirebaseConfig(): FirebaseOptions {
  const apiKey = firstNonEmpty(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  );
  const authDomain = firstNonEmpty(
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  );
  const projectId = firstNonEmpty(
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  );
  const storageBucket = firstNonEmpty(
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  );
  const messagingSenderId = firstNonEmpty(
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  );
  const appId = firstNonEmpty(
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  );

  return {
    apiKey: getRequiredEnv(
      apiKey,
      "NEXT_PUBLIC_FIREBASE_API_KEY",
    ),
    authDomain: getRequiredEnv(
      authDomain,
      "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    ),
    projectId: getRequiredEnv(
      projectId,
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    ),
    storageBucket: getRequiredEnv(
      storageBucket,
      "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
    ),
    messagingSenderId: getRequiredEnv(
      messagingSenderId,
      "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    ),
    appId: getRequiredEnv(
      appId,
      "NEXT_PUBLIC_FIREBASE_APP_ID",
    ),
  };
}

function getFirebaseApp() {
  if (typeof window === "undefined") {
    throw new Error("Firebase client is only available in the browser.");
  }

  if (!appInitialized) {
    const firebaseConfig = getFirebaseConfig();
    if (getApps().length === 0) {
      initializeApp(firebaseConfig);
    }
    appInitialized = true;
  }

  return getApp();
}

export function getClientDb() {
  return getFirestore(getFirebaseApp());
}

export function getClientStorage() {
  return getStorage(getFirebaseApp());
}
