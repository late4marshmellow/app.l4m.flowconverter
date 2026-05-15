'use strict';

const Homey = require('homey');
const { HomeyAPIApp } = require('homey-api');
const crypto = require('crypto');

// AES-256-GCM settings key names.
const ALGO        = 'aes-256-gcm';
const KEY_SETTING = '_tok_key';  // hex-encoded 32-byte AES key
const ENC_SETTING = '_tok_enc';  // JSON { iv, ct, tag } (all base64)
const ACT_SETTING = 'personal_api_token_active'; // boolean flag for UI

function redactSecrets(value) {
  const text = String(value || '');
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+=*/g, '$1[REDACTED]')
    .replace(/(personal_api_token\s*[:=]\s*)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/([?&](?:token|api[_-]?key|authorization)=)[^&\s]+/ig, '$1[REDACTED]');
}

function safeErrorMessage(err) {
  const raw = err && err.message ? err.message : String(err || 'Unknown error');
  return redactSecrets(raw);
}

class FlowConverterApp extends Homey.App {
  async onInit() {
    this.log('FlowConverterApp is running');

    this._handlingTokenEncryption = false;  // re-entry guard for settings listeners

    try {
      // We don't initialize a global HomeyAPIApp anymore to avoid state leakage.
      this.log('App init finished without global HomeyAPIApp');
      await this._migrateOrApplyToken();
    } catch (err) {
      this.error(`Failed to create homeyApi: ${safeErrorMessage(err)}`);
    }

    // Inject app instance into API module for ManagerApi handler access.
    try {
      const api = require('./api');
      if (api && typeof api.setApp === 'function') {
        api.setApp(this);
      }
    } catch (e) {
      this.error(`Failed to set app on api module: ${safeErrorMessage(e)}`);
    }

    // Encrypt and apply when a new plain token arrives from the settings page.
    this.homey.settings.on('set', (key) => {
      if (key === 'personal_api_token' && !this._handlingTokenEncryption) {
        this.log('personal_api_token set — encrypting and applying');
        this._encryptAndApplyToken().catch(err =>
          this.error(`_encryptAndApplyToken failed: ${safeErrorMessage(err)}`)
        );
      }
    });

    // Clear all token material when the settings page unsets the plain token key.
    this.homey.settings.on('unset', (key) => {
      if (key === 'personal_api_token' && !this._handlingTokenEncryption) {
        this.log('personal_api_token unset — clearing token material');
        this._clearTokenMaterial().catch(err =>
          this.error(`_clearTokenMaterial failed: ${safeErrorMessage(err)}`)
        );
      }
    });
  }

  // On startup: migrate legacy plain token if needed, otherwise validate encrypted token exists.
  async _migrateOrApplyToken() {
    const plain = await this.homey.settings.get('personal_api_token');
    const enc   = await this.homey.settings.get(ENC_SETTING);
    if (plain && !enc) {
      this.log('Migrating legacy plain token to encrypted storage');
      await this._encryptAndApplyToken();
    } else if (enc) {
      this.log('Encrypted token found on startup — ready for on-demand decryption');
    }
  }

  // Generate or retrieve the 32-byte AES key, persisting it if new.
  async _getOrCreateEncKey() {
    let keyHex = await this.homey.settings.get(KEY_SETTING);
    if (!keyHex || typeof keyHex !== 'string' || keyHex.length !== 64) {
      keyHex = crypto.randomBytes(32).toString('hex');
      await this.homey.settings.set(KEY_SETTING, keyHex);
      this.log('New AES-256 encryption key generated');
    }
    return Buffer.from(keyHex, 'hex');
  }

  // Encrypt plainToken with AES-256-GCM. Returns a JSON string envelope.
  _encryptToken(keyBuf, plainToken) {
    const iv     = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGO, keyBuf, iv);
    const ct     = Buffer.concat([cipher.update(plainToken, 'utf8'), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return JSON.stringify({
      iv:  iv.toString('base64'),
      ct:  ct.toString('base64'),
      tag: tag.toString('base64'),
    });
  }

  // Decrypt an AES-256-GCM JSON envelope. Throws if auth tag is invalid (tamper detected).
  _decryptToken(keyBuf, encJson) {
    const { iv, ct, tag } = JSON.parse(encJson);
    const decipher = crypto.createDecipheriv(ALGO, keyBuf, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  // Load key, decrypt token, zero the key buffer, and return the plaintext.
  // Key is never persisted in memory between calls.
  async _loadAndDecryptToken() {
    const encJson = await this.homey.settings.get(ENC_SETTING);
    if (!encJson) {
      throw new Error('No encrypted token found in settings');
    }
    const keyBuf = await this._getOrCreateEncKey();
    try {
      return this._decryptToken(keyBuf, encJson);
    } finally {
      keyBuf.fill(0);
    }
  }

  // Execute a callback with the decrypted plaintoken.
  // Token is never persisted to any global API instances.
  async _withDecryptedToken(callback) {
    const plainToken = await this._loadAndDecryptToken();
    return await callback(plainToken);
  }

  // Read the plain token written by the settings page, encrypt it, persist the
  // ciphertext, and remove the plain value so it never stays on disk.
  async _encryptAndApplyToken() {
    const plainToken = await this.homey.settings.get('personal_api_token');
    if (!plainToken) {
      await this._clearTokenMaterial();
      return;
    }
    try {
      const keyBuf = await this._getOrCreateEncKey();
      try {
        const encJson = this._encryptToken(keyBuf, plainToken);
        await this.homey.settings.set(ENC_SETTING, encJson);
        await this.homey.settings.set(ACT_SETTING, true);

        // Remove the plain token. Guard prevents the unset listener from re-entering.
        this._handlingTokenEncryption = true;
        try {
          await this.homey.settings.unset('personal_api_token');
        } finally {
          this._handlingTokenEncryption = false;
        }

        this.log('Token encrypted; plain value removed from settings');
      } finally {
        keyBuf.fill(0);
      }
    } catch (err) {
      this.error(`Token encryption failed: ${safeErrorMessage(err)}`);
    }
  }

  // Clear all token material from settings.
  async _clearTokenMaterial() {
    await this.homey.settings.unset(ENC_SETTING);
    await this.homey.settings.unset(ACT_SETTING);
    this.log('Token material cleared');
  }
}

module.exports = FlowConverterApp;
