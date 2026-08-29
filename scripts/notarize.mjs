import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { notarize } from '@electron/notarize';

const execFileAsync = promisify(execFile);
const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 1_000;
const REQUIRED_CREDENTIALS = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];
const TRANSIENT_ERROR_PATTERN = /(?:eai_again|econn(?:reset|refused)|enet(?:down|unreach)|etimedout|timed?\s*out|temporar(?:y|ily)|service\s+unavailable|internal\s+server\s+error|rate\s+limit|too\s+many\s+requests|\b5\d{2}\b)/iu;

function isDryRun() {
  return process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false';
}

function missingCredentials() {
  return REQUIRED_CREDENTIALS.filter((name) => !process.env[name]?.trim());
}

function errorText(error) {
  return [error?.code, error?.status, error?.statusCode, error?.message, error?.stdout, error?.stderr]
    .filter((value) => value !== undefined && value !== null)
    .join('\n');
}

function isTransientError(error) {
  return TRANSIENT_ERROR_PATTERN.test(errorText(error));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appPathFor(context) {
  const appOutDir = context?.appOutDir;
  const productFilename = context?.packager?.appInfo?.productFilename;
  if (!appOutDir || !productFilename) {
    throw new Error('Notarization hook received an invalid electron-builder context: appOutDir and packager.appInfo.productFilename are required.');
  }
  return path.join(appOutDir, `${productFilename}.app`);
}

async function notarizeWithRetry(options) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await notarize(options);
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === MAX_ATTEMPTS) throw error;
      const delay = INITIAL_BACKOFF_MS * (2 ** (attempt - 1));
      console.warn(`[notarize] transient notarization failure on attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${delay}ms.`);
      await wait(delay);
    }
  }
  throw new Error(
    `[notarize] Notarization failed after ${MAX_ATTEMPTS} attempts: ${errorText(lastError) || 'unknown error'}`,
    { cause: lastError },
  );
}

async function verifyStaple(appPath) {
  try {
    // notarize() staples the accepted app; validate the ticket and Gatekeeper assessment explicitly.
    await execFileAsync('xcrun', ['stapler', 'validate', appPath]);
    await execFileAsync('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
  } catch (error) {
    throw new Error(`[notarize] Staple or Gatekeeper validation failed for ${appPath}: ${errorText(error) || 'unknown error'}`, { cause: error });
  }
  console.log(`[notarize] Staple and Gatekeeper validation passed for ${appPath}.`);
}

export default async function afterSign(context) {
  if (isDryRun()) {
    console.warn('[notarize] SIGNING IS DISABLED (CSC_IDENTITY_AUTO_DISCOVERY=false); skipping notarization and staple verification for this unsigned dry-run.');
    return;
  }

  const missing = missingCredentials();
  if (missing.length > 0) {
    throw new Error(
      `[notarize] Missing required notarization environment variables: ${missing.join(', ')}. Set them for a signed build, or explicitly set CSC_IDENTITY_AUTO_DISCOVERY=false only for an unsigned dry-run.`,
    );
  }

  const appPath = appPathFor(context);
  console.log(`[notarize] Submitting ${appPath} to Apple notary service.`);
  await notarizeWithRetry({
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
  // @electron/notarize's public notarize() API staples the accepted app before returning.
  await verifyStaple(appPath);
}
