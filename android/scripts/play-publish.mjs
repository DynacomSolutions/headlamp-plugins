#!/usr/bin/env node
// Puts a signed bundle on a Google Play track through the Play Developer API. No dependencies (Node 20+).
// Used by .github/workflows/android-release.yml; see README.md.
//
//   HEADLAMPS_APPLICATION_ID=... PLAY_SERVICE_ACCOUNT_JSON_BASE64=... node scripts/play-publish.mjs --aab <path> [--track internal] [--dry-run]
//   HEADLAMPS_APPLICATION_ID=... PLAY_SERVICE_ACCOUNT_JSON_BASE64=... node scripts/play-publish.mjs --listing-only [--dry-run]
//
// Version code and name come from version.properties; release notes from
// fastlane/metadata/android/<language>/changelogs/<versionCode>.txt.
// Store listing text and icon come from fastlane/metadata/android/<language>/:
// title.txt, short_description.txt, full_description.txt and images/icon.png.
// --dry-run does everything except the commit: Play validates the edit, then the edit is deleted.
// --listing-only pushes only the store listing: no bundle upload, no track update, no new version code.
import { createHash, createSign } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://androidpublisher.googleapis.com'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const dryRun = args.includes('--dry-run')
const listingOnly = args.includes('--listing-only')
const track = opt('track', 'internal')
const aab = opt('aab')

const fail = (message) => {
  console.error(`play-publish: ${message}`)
  process.exit(1)
}

// The package name is a secret. Never print it.
const PACKAGE = process.env.HEADLAMPS_APPLICATION_ID
if (!PACKAGE) fail('HEADLAMPS_APPLICATION_ID is not set')

const NOT_FOUND_MESSAGE =
  'Play does not know this app. Create the app in Play Console first, then upload the first bundle there by hand. ' +
  'Play has no API for that step. The signed bundle is in the workflow artifact.'

const version = Object.fromEntries(
  readFileSync(join(root, 'version.properties'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => l.split('=').map((s) => s.trim())),
)
const versionCode = Number(version.versionCode)
if (!Number.isInteger(versionCode) || !version.versionName) fail('version.properties has no versionCode or versionName')

const metadata = join(root, 'fastlane/metadata/android')
const languages = readdirSync(metadata, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
const releaseNotes = (listingOnly ? [] : languages)
  .map((language) => ({ language, file: join(metadata, language, 'changelogs', `${versionCode}.txt`) }))
  .filter((n) => existsSync(n.file))
  .map((n) => ({ language: n.language, text: readFileSync(n.file, 'utf8').trim() }))
if (!listingOnly && releaseNotes.length === 0) fail(`no release notes for version code ${versionCode} under fastlane/metadata/android`)
for (const n of releaseNotes) if ([...n.text].length > 500) fail(`${n.language} release notes are over 500 characters`)

const encoded = process.env.PLAY_SERVICE_ACCOUNT_JSON_BASE64
if (!encoded) fail('PLAY_SERVICE_ACCOUNT_JSON_BASE64 is not set')
const account = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))

const b64url = (data) => Buffer.from(data).toString('base64url')

async function request(method, url, { token, body, type } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = type ?? 'application/json'
  const response = await fetch(url, { method, headers, body })
  const text = await response.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text.slice(0, 300) }
  }
  if (!response.ok) {
    const reason = data.error?.message ?? data.error_description ?? data.raw ?? response.statusText
    if (response.status === 404 && /package not found/i.test(String(reason))) throw new Error(NOT_FOUND_MESSAGE)
    // The path holds the package name, so it is not printed.
    const error = new Error(`${method} ${new URL(url).pathname.replaceAll(PACKAGE, '<package>')}: ${response.status} ${reason}`)
    error.status = response.status
    throw error
  }
  return data
}

// Pushes the title, the descriptions and the icon of each language folder into the edit.
// The icon is replaced only when its sha256 differs from the one Play holds.
async function syncListings(edits, edit, token) {
  const texts = { title: 'title.txt', shortDescription: 'short_description.txt', fullDescription: 'full_description.txt' }
  for (const language of languages) {
    const folder = join(metadata, language)
    const local = {}
    for (const [field, name] of Object.entries(texts)) {
      if (existsSync(join(folder, name))) local[field] = readFileSync(join(folder, name), 'utf8').trim()
    }
    const listing = `${edits}/${edit}/listings/${language}`
    if (Object.keys(local).length > 0) {
      // Keep the text that Play already holds: Play rejects empty descriptions on production.
      let current = null
      try {
        current = await request('GET', listing, { token })
      } catch (error) {
        if (error.status !== 404) throw error
      }
      const next = { language, ...(current ?? {}), ...local }
      const changed = Object.keys(local).filter((field) => current?.[field] !== local[field])
      await request(current ? 'PATCH' : 'PUT', listing, { token, body: JSON.stringify(next) })
      console.log(`${language}: listing ${changed.length > 0 ? `updated (${changed.join(', ')})` : 'already up to date'}`)
    }
    const iconFile = join(folder, 'images', 'icon.png')
    if (existsSync(iconFile)) {
      const bytes = readFileSync(iconFile)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      let held = []
      try {
        held = (await request('GET', `${listing}/icon`, { token })).images ?? []
      } catch (error) {
        if (error.status !== 404) throw error
      }
      if (held.length === 1 && String(held[0].sha256).toLowerCase() === sha256) {
        console.log(`${language}: icon already up to date (sha256 ${sha256})`)
      } else {
        if (held.length > 0) await request('DELETE', `${listing}/icon`, { token })
        const uploaded = await request(
          'POST',
          `${API}/upload/androidpublisher/v3/applications/${PACKAGE}/edits/${edit}/listings/${language}/icon?uploadType=media`,
          { token, body: bytes, type: 'image/png' },
        )
        console.log(`${language}: icon uploaded (sha256 ${uploaded.image?.sha256 ?? sha256})`)
      }
    }
  }
}

async function accessToken() {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = [
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    b64url(
      JSON.stringify({
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/androidpublisher',
        aud: account.token_uri,
        iat: now,
        exp: now + 600,
      }),
    ),
  ].join('.')
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key).toString('base64url')
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsigned}.${signature}`,
  })
  const data = await request('POST', account.token_uri, { body: form.toString(), type: 'application/x-www-form-urlencoded' })
  return data.access_token
}

const token = await accessToken()
const edits = `${API}/androidpublisher/v3/applications/${PACKAGE}/edits`
let edit
try {
  edit = (await request('POST', edits, { token, body: '{}' })).id
} catch (error) {
  fail(error.message.replaceAll(PACKAGE, '<package>'))
}
let committed = false
try {
  let release = null
  if (!listingOnly) {
    const held = ((await request('GET', `${edits}/${edit}/bundles`, { token })).bundles ?? []).map((b) => b.versionCode)
    if (held.includes(versionCode)) {
      // Play never takes a version code twice. A bundle that is already there is put on the track as it is.
      console.log(`bundle ${versionCode} is already on Play: not uploaded again`)
    } else {
      if (!aab) throw new Error('--aab is needed: Play does not hold this version code yet')
      const uploaded = await request(
        'POST',
        `${API}/upload/androidpublisher/v3/applications/${PACKAGE}/edits/${edit}/bundles?uploadType=media`,
        { token, body: readFileSync(aab), type: 'application/octet-stream' },
      )
      if (uploaded.versionCode !== versionCode) {
        throw new Error(`uploaded bundle has version code ${uploaded.versionCode}, expected ${versionCode}`)
      }
      console.log(`uploaded bundle ${versionCode} (sha256 ${uploaded.sha256})`)
    }

    release = {
      name: `${versionCode} (${version.versionName})`,
      versionCodes: [String(versionCode)],
      status: 'completed',
      releaseNotes,
    }
    await request('PUT', `${edits}/${edit}/tracks/${track}`, { token, body: JSON.stringify({ track, releases: [release] }) })
  }

  await syncListings(edits, edit, token)

  if (dryRun) {
    await request('POST', `${edits}/${edit}:validate`, { token })
    console.log(
      listingOnly
        ? 'dry run: Play accepts the store listing; nothing was published'
        : `dry run: Play accepts release ${release.name} on the ${track} track; nothing was published`,
    )
  } else {
    await request('POST', `${edits}/${edit}:commit`, { token })
    committed = true
    console.log(listingOnly ? 'published the store listing' : `released ${release.name} to the ${track} track`)
  }
} catch (error) {
  console.error(`play-publish: ${error.message.replaceAll(PACKAGE, '<package>')}`)
  process.exitCode = 1
} finally {
  // A committed edit is gone; any other edit is removed so that it does not block the next one.
  if (!committed) await request('DELETE', `${edits}/${edit}`, { token }).catch(() => {})
}
