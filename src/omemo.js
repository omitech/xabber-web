define("xabber-omemo", function () {
    return function (xabber) {
        var env = xabber.env,
            constants = env.constants,
            utils = env.utils,
            $ = env.$,
            templates = env.templates.base,
            Strophe = env.Strophe,
            _ = env._,
            KeyHelper = libsignal.KeyHelper,
            SignalProtocolAddress = libsignal.SignalProtocolAddress,
            SessionBuilder = libsignal.SessionBuilder,
            SessionCipher = libsignal.SessionCipher,
            FingerprintGenerator = libsignal.FingerprintGenerator;

        xabber.Peer = Backbone.Model.extend({
            idAttribute: 'jid',

            initialize: function (attrs, options) {
                attrs = attrs || {};
                this.account = options.account;
                this.devices = {};
                this.fingerprints = new xabber.Fingerprints({model: this});
                this.updateDevices(attrs.devices);
                this.own_devices = {};
                this.onOwnDevicesUpdated();
                this.account.on("devices_updated", this.onOwnDevicesUpdated, this);
                this.set({
                    jid: attrs.jid
                });
            },

            updateDevices: function (devices) {
                if (!devices)
                    return;
                for (let d in this.devices) {
                    if (!devices[d])
                        delete this.devices[d];
                }
                for (let d in devices) {
                    let device = this.getDevice(d),
                        label = devices[d].label;
                    label && device.set('label', label);
                }
            },

            onOwnDevicesUpdated: function () {
                this.updateOwnDevices(this.account.connection.omemo.devices);
            },

            updateOwnDevices: function (devices) {
                if (!devices)
                    return;
                for (let d in this.own_devices) {
                    if (!devices[d])
                        delete this.own_devices[d];
                }
                for (let d in devices) {
                    let device = this.getOwnDevice(d),
                        label = devices[d].label;
                    label && device.set('label', label);
                }
            },

            getDevicesNode: async function () {
                return new Promise((resolve, reject) => {
                    this.account.connection.omemo.getDevicesNode(this.get('jid'), function (cb) {
                        this.updateDevices(this.account.connection.omemo.getUserDevices($(cb)));
                        resolve();
                    }.bind(this), function () {
                        resolve();
                    });
                });
            },

            encrypt: async function (message) {
                let enc_promises = [],
                    aes = await utils.AES.encrypt(message),
                    is_trusted = true;

                if (!_.keys(this.devices).length)
                    await this.getDevicesNode();
                for (let device in this.devices) {
                    enc_promises.push(this.devices[device].encrypt(aes.keydata));
                }

                for (let device in this.own_devices) {
                    enc_promises.push(this.own_devices[device].encrypt(aes.keydata));
                }

                let keys = await Promise.all(enc_promises);

                keys = keys.filter(key => key !== null);

                for (let device in this.devices) {
                    if (this.devices[device].get('trusted') === false)
                        is_trusted = false;
                    if (is_trusted && this.devices[device].get('trusted') === undefined)
                        is_trusted = undefined;
                }

                return {
                    keys: keys,
                    iv: aes.iv,
                    payload: aes.payload,
                    is_trusted: is_trusted
                };
            },

            decrypt: async function (deviceId, ciphertext, preKey) {
                let device = this.getDevice(deviceId);

                return device.decrypt(ciphertext, preKey);
            },

            getOwnDevice: function (id) {
                if (!this.own_devices[id]) {
                    this.own_devices[id] = new xabber.Device({jid: this.account.get('jid'), id: id }, { account: this.account, store: this.account.omemo.store});
                }

                return this.own_devices[id];
            },

            getDevice: function (id) {
                if (!this.devices[id]) {
                    this.devices[id] = new xabber.Device({jid: this.get('jid'), id: id }, { account: this.account, store: this.account.omemo.store});
                }

                return this.devices[id];
            }
        });

        xabber.Peers = Backbone.Collection.extend({
            model: xabber.Peer,

            initialize: function (models, options) {
                this.collections = [];
                this.on("add", _.bind(this.updateInCollections, this, 'add'));
                this.on("change", _.bind(this.updateInCollections, this, 'change'));
            },

            addCollection: function (collection) {
                this.collections.push(collection);
            },

            updateInCollections: function (event, contact) {
                _.each(this.collections, function (collection) {
                    collection.update(contact, event);
                });
            }
        });

        xabber.Fingerprints = xabber.BasicView.extend({
            className: 'modal main-modal fingerprints-wrap',
            template: templates.fingerprints,
            ps_selector: '.fingerprints-content',
            ps_settings: {theme: 'item-list'},

            events: {
                'click .btn-trust': "trustDevice",
                'click .btn-ignore': "ignoreDevice",
                'click .btn-cancel': "close",
                'click .fingerprints-header>div': "selectTable"
            },

            _initialize: function () {
                this.account = this.model.account;
                this.omemo = this.account.omemo;
                this.jid = this.model.get('jid');
                this.fingerprints = [];
                this.own_fingerprints = [];
            },

            selectTable: function (ev) {
                let $target = $(ev.target);
                if ($target.hasClass('active'))
                    return;
                this.$('.fingerprints-header>div').removeClass('active');
                $target.addClass('active');
                this.$('tbody.contact-fingerprints').showIf($target.hasClass('contact-devices'));
                this.$('tbody.own-fingerprints').showIf($target.hasClass('own-devices'));
            },

            open: function () {
                this.data.set('visible', true);
                this.show();
                this.renderDevices();
            },

            renderDevices: function () {
                this.model.getDevicesNode().then(() => {
                    this.updateContactFingerprints();
                });
                this.updateOwnFingerprints();
            },

            render: function () {
                this.$el.openModal({
                    complete: function () {
                        this.$el.detach();
                        this.data.set('visible', false);
                    }.bind(this)
                });
            },

            updateFingerprints: async function (devices, $container) {
                let counter = 0,
                    devices_count = _.keys(devices).length,
                    dfd = new $.Deferred();
                dfd.done((f_count) => {
                    if (!f_count)
                        $container.html($('<tr class="empty-table"><td colspan="3">No fingerprints yet</td></tr>'));
                    else
                        this.$('.dropdown-button').dropdown({
                            inDuration: 100,
                            outDuration: 100,
                            constrainWidth: false,
                            hover: false,
                            alignment: 'left'
                        });
                });
                $container.html("");
                for (var device_id in devices) {
                    let device = devices[device_id];
                    if (device.get('ik')) {
                        let f = device.generateFingerprint(),
                            fing = (this.omemo.get('fingerprints')[(this.model.devices[device_id] ? this.jid : this.account.get('jid'))] || []).find(a => a.fingerprint == f),
                            is_trusted = fing ? (fing.trusted ? 'trust' : 'ignore') : 'unknown';
                        $container.append(this.addRow(device.id, device.get('label'), is_trusted, f));
                        counter++;
                        if (devices_count == counter)
                            dfd.resolve($container.find('tr').length);
                    }
                    else {
                        this.account.connection.omemo.getBundleInfo({jid: device.jid, id: device.id}, async function (iq) {
                            let $iq = $(iq),
                                $bundle = $iq.find(`item bundle[xmlns="${Strophe.NS.OMEMO}"]`),
                                ik = $bundle.find(`ik`).text();
                            if (ik) {
                                device.set('ik', utils.fromBase64toArrayBuffer(ik));
                                let f = device.generateFingerprint(),
                                    fing = (this.omemo.get('fingerprints')[(this.model.devices[device_id] ? this.jid : this.account.get('jid'))] || []).find(a => a.fingerprint == f),
                                    is_trusted = fing ? (fing.trusted ? 'trust' : 'ignore') : 'unknown';
                                $container.append(this.addRow(device.id, device.get('label'), is_trusted, f));
                            }
                            counter++;
                            if (devices_count == counter)
                                dfd.resolve($container.find('tr').length);
                        }.bind(this), function () {
                            counter++;
                            if (devices_count == counter)
                                dfd.resolve($container.find('tr').length);
                        }.bind(this));
                    }
                }
            },

            updateOwnFingerprints: async function () {
                let own_devices = _.clone(this.model.own_devices);
                delete own_devices[this.omemo.get('device_id')];
                this.updateFingerprints(own_devices, this.$('tbody.own-fingerprints'));

            },

            updateContactFingerprints: async function () {
                this.updateFingerprints(this.model.devices, this.$('tbody.contact-fingerprints'));
            },

            close: function () {
                var deferred = new $.Deferred();
                this.$el.closeModal({ complete: function () {
                        this.$el.detach();
                        this.data.set('visible', false);
                        deferred.resolve();
                    }.bind(this)});
                return deferred.promise();
            },

            trustDevice: function (ev) {
                let $target = $(ev.target).closest('tr'),
                    fingerprint = $target.children('.fingerprint').text().replace(/ /g, ""),
                    is_trusted = $target.children('th[data-trust]').attr('data-trust'),
                    device_id = Number($target.children('th.device-id').text());
                $target.children('th[data-trust]').attr('data-trust', 'trust');
                $target.find('.trust-item-wrap').children().attr('data-value', 'trust').text('trust');
                this.omemo.updateFingerprints((this.model.devices[device_id] ? this.jid : this.account.get('jid')), fingerprint, true);
                let device = this.model.devices[device_id] || this.model.own_devices[device_id];
                if (device && is_trusted != 'trusted') {
                    device.set('trusted', true);
                    device.is_session_initiated = false;
                    device.preKeys = null;
                }
            },

            ignoreDevice: function (ev) {
                let $target = $(ev.target).closest('tr'),
                    fingerprint = $target.children('.fingerprint').text().replace(/ /g, ""),
                    is_trusted = $target.children('th[data-trust]').attr('data-trust'),
                    device_id = Number($target.children('th.device-id').text());
                $target.children('th[data-trust]').attr('data-trust', 'ignore');
                $target.find('.trust-item-wrap').children().attr('data-value', 'ignore').text('ignore');
                this.omemo.updateFingerprints((this.model.devices[device_id] ? this.jid : this.account.get('jid')), fingerprint, false);
                let device = this.model.devices[device_id] || this.model.own_devices[device_id];
                if (device && is_trusted != 'ignore') {
                    device.set('trusted', false);
                    device.is_session_initiated = false;
                    device.preKeys = null;
                }
            },

            addRow: function (id, label, trust, fingerprint) {
                fingerprint = fingerprint.match(/.{1,8}/g).join(" ");
                let $row = $('<tr/>');
                $row.append($('<th class="device-id"/>').text(id));
                $row.append($('<th/>').text(label || ""));
                $row.append($(`<th title="${fingerprint}" class="fingerprint"/>`).text(fingerprint));
                // $row.append($(`<th data-trust="${trust}"/>`).text(trust));
                $row.append($(`<th data-trust="${trust}" class="buttons"/>`).append(
                    $(`<div class="dropdown-button" data-activates='select-status-${id}'>
<div class="trust-item-wrap btn-main btn-flat">
<div data-value='${trust}' class="">${trust}</div></div></div>
<div id='select-status-${id}' class="dropdown-content noselect">
<div data-value="ignore" class="btn-main text-color-grey-500 btn-ignore btn-flat">Ignore</div>
<div data-value="trust" class="btn-main btn-flat btn-trust text-color-green-500">Trust</div></div>`)
                ));
                return $row;
            }
        });

        xabber.Bundle = Backbone.Model.extend({
            initialize: async function (attrs, options) {
                this.preKeys = [];
                this.model = options.model;
                this.store = options.store;
                if (this.model.get('identityKey'))
                    this.getIdentity();
                else
                    await this.generateIdentity();
               await this.getPreKeys();
               if (this.model.get('resend_bundle')) {
                   this.model.publishBundle();
                   this.set('resend_bundle', false);
               }
            },

            generateIdentity: function () {
                return Promise.all([
                    KeyHelper.generateIdentityKeyPair(),
                    KeyHelper.generateRegistrationId(),
                ]).then((result) => {
                    let identityKey = result[0],
                        registrationId = result[1];
                    this.store.put('identityKey', identityKey);
                    this.store.put('registrationId', registrationId);
                    this.cacheIdentity(identityKey, registrationId);
                });
            },

            getIdentity: function () {
                let identityKey = JSON.parse(this.model.get('identityKey')),
                    registrationId = this.model.get('registrationId'),
                    pubKey = utils.fromBase64toArrayBuffer(identityKey.pubKey),
                    privKey = utils.fromBase64toArrayBuffer(identityKey.privKey);
                this.store.put('identityKey', {pubKey: pubKey, privKey: privKey});
                this.store.put('registrationId', registrationId);
            },

            cacheIdentity: function (identityKey, registrationId) {
                let pubKey = utils.ArrayBuffertoBase64(identityKey.pubKey),
                    privKey = utils.ArrayBuffertoBase64(identityKey.privKey);
                this.model.save('identityKey', JSON.stringify({pubKey: pubKey, privKey: privKey}));
                this.model.save('registrationId', registrationId);
            },

            generatePreKeys: async function () {
                let preKeysPromises = [];
                for (let i = 1; i <= constants.PREKEYS_COUNT; i++) {
                    preKeysPromises.push(this.generatePreKey(i));
                }

                preKeysPromises.push(this.generateSignedPreKey(1));

                return await Promise.all(preKeysPromises);
            },

            getSignedPreKey: async function () {
                let spk = this.model.get('signedPreKey');
                if (spk) {
                    let pubKey = utils.fromBase64toArrayBuffer(spk.keyPair.pubKey),
                        privKey = utils.fromBase64toArrayBuffer(spk.keyPair.privKey),
                        signature = utils.fromBase64toArrayBuffer(spk.signature),
                        keyPair = {pubKey, privKey},
                        keyId = spk.keyId;
                    return {keyPair, keyId, signature};
                }
                else {
                    return await this.generateSignedPreKey(this.preKeys[0].keyId || 1);
                }
            },

            getPreKeys: async function () {
                let prekeys = this.model.prekeys.getAll();
                if (Object.keys(prekeys).length >= constants.MIN_PREKEYS_COUNT) {
                    for (let p in prekeys) {
                        let pk = prekeys[p],
                            id = pk.id,
                            prekey = JSON.parse(pk.key),
                            priv_pk = utils.fromBase64toArrayBuffer(prekey.privKey),
                            pub_pk = utils.fromBase64toArrayBuffer(prekey.pubKey),
                            key_pair = {pubKey: pub_pk, privKey: priv_pk};
                        this.preKeys.push({keyId: id, keyPair: key_pair});
                        this.store.storePreKey(id, key_pair);
                    }
                    this.getUsedPreKeys();
                    let spk = await this.getSignedPreKey();
                    this.preKeys.push(spk);
                    this.store.storeSignedPreKey(spk.keyId, spk.keyPair);
                }
                else {
                    this.generatePreKeys().then((prekeys) => {
                        this.preKeys = prekeys;
                        this.getUsedPreKeys();
                    });
                }
            },

            getUsedPreKeys: function () {
                let prekeys = this.model.own_used_prekeys.getAll();
                if (Object.keys(prekeys).length) {
                    for (let p in prekeys) {
                        let pk = prekeys[p],
                            id = pk.id,
                            prekey = JSON.parse(pk.key),
                            privKey = utils.fromBase64toArrayBuffer(prekey.privKey),
                            pubKey = utils.fromBase64toArrayBuffer(prekey.pubKey);
                        this.store.storePreKey(id, {pubKey, privKey});
                    }
                }
            },

            generatePreKey: async function (id) {
                let preKey = await KeyHelper.generatePreKey(id);
                this.store.storePreKey(id, preKey.keyPair);

                return preKey;
            },

            generateSignedPreKey: async function (id) {
                let identity = await this.store.getIdentityKeyPair();
                let signedPreKey = await KeyHelper.generateSignedPreKey(identity, id);

                this.store.storeSignedPreKey(id, signedPreKey.keyPair);
                this.cacheSignedPreKey(signedPreKey);

                return signedPreKey;
            },

            cacheSignedPreKey: function (spk) {
                let pubKey = utils.ArrayBuffertoBase64(spk.keyPair.pubKey),
                    privKey = utils.ArrayBuffertoBase64(spk.keyPair.privKey),
                    signature = utils.ArrayBuffertoBase64(spk.signature),
                    keyPair = {pubKey, privKey},
                    keyId = spk.keyId,
                    converted_spk = {keyPair, keyId, signature};
                this.model.save('signedPreKey', converted_spk);
            }

        });
        
        xabber.Prekeys = Backbone.Model.extend({
            initialize: function (options) {
                this.name = options.name;
                this.model = options.model;
            },

            get: function (id) {
                let prekeys = _.clone(this.model.get(this.name));
                return prekeys[id];
            },

            put: function (prekey) {
                if (!prekey.id)
                    return;
                let prekeys = _.clone(this.model.get(this.name));
                prekeys[prekey.id] = prekey;
                this.model.save(this.name, prekeys);
            },

            getAll: function () {
                let prekeys = _.clone(this.model.get(this.name));
                return prekeys;
            },

            remove: function (id) {
                if (!id)
                    return;
                let prekeys = _.clone(this.model.get(this.name));
                delete prekeys[id];
                this.model.save(this.name, prekeys);
            }
        });

        xabber.Device = Backbone.Model.extend({
            initialize: function (attrs, options) {
                this.account = options.account;
                this.id = attrs.id;
                this.jid = attrs.jid;
                this.store = options.store;
                this.preKeys = null;
                this.address = new SignalProtocolAddress(attrs.jid, attrs.id);
            },

            generateFingerprint: function () {
                let identityKey = this.get('ik');
                if (!identityKey)
                    return;
                if (identityKey.byteLength == 33)
                    identityKey = identityKey.slice(1);
                return Array.from(new Uint8Array(identityKey)).map (b => b.toString(16).padStart(2, "0")).join("");
            },

            closeSession: function (reason) {
                this.account.connection.omemo.sendOptOut({
                    to: this.jid,
                    reason: reason
                }, function () {

                }.bind(this));
            },

            getBundle: async function () {
                return new Promise((resolve, reject) => {
                    this.account.connection.omemo.getBundleInfo({jid: this.jid, id: this.id}, function (iq) {
                        let $iq = $(iq),
                            $bundle = $iq.find(`item bundle[xmlns="${Strophe.NS.OMEMO}"]`),
                            $spk = $bundle.find('spk'),
                            spk = {id: $spk.attr('id'), key: $spk.text(), signature: $bundle.find('spks').text()},
                            ik =  $bundle.find(`ik`).text();
                        this.preKeys = [];
                        $bundle.find('prekeys pk').each((i, pk) => {
                            let $pk = $(pk);
                            this.preKeys.push({id: $pk.attr('id'), key: $pk.text()});
                        });
                        let pk = this.getRandomPreKey();
                        if (!pk)
                            reject();
                        else
                            resolve({pk, spk, ik});
                    }.bind(this), function () {
                        this.preKeys = [];
                        reject();
                    }.bind(this));
                });
            },

            getRandomPreKey: function () {
                let min = 0,
                    max = this.preKeys.length - 1,
                    i = Math.floor(min + Math.random() * (max + 1 - min));
                return this.preKeys[i];
            },

            decrypt: async function (cipherText, preKey) {
                try {
                    let sessionCipher = new SessionCipher(this.store, this.address), plainText;

                    if (preKey)
                        plainText = await sessionCipher.decryptPreKeyWhisperMessage(cipherText, 'binary');
                    else {
                        if (!this.store.hasSession(this.address.toString())) {
                            let session = this.getCachedSession();
                            session && await this.store.storeSession(this.address.toString(), session);
                        }
                        plainText = await sessionCipher.decryptWhisperMessage(cipherText, 'binary');
                    }

                    return plainText;
                }
                catch (e) {
                    return null;
                }
            },

            getPreKey: function () {
                let pk = this.account.omemo.used_prekeys.get(String(this.id));
                return pk;
            },

            getCachedSession: function () {
                return this.account.omemo.getSession('session' + this.address.toString());
            },

            encrypt: async function (plainText) {
                try {
                    if (this.get('trusted') === false && (this.id != this.account.omemo.get('device_id')))
                        return null;
                    if (!this.store.hasSession(this.address.toString()) || !this.is_session_initiated) { // this.preKeys ??
                        if (this.preKeys && !this.preKeys.length)
                            return null;
                        this.is_session_initiated = true;
                        let s = await this.initSession();
                        if (!s)
                            return null;
                    }

                    let session = this.getSession(),
                        ciphertext = await session.encrypt(plainText);

                    return {
                        preKey: ciphertext.type === 3,
                        ciphertext: ciphertext,
                        deviceId: this.address.getDeviceId(),
                        preKeyMsg: ciphertext.preKeyMsg,
                        session: ciphertext.session
                    };
                } catch (e) {
                    console.log('Error:', e);
                    console.warn('Could not encrypt data for device with id ' + this.address.getDeviceId());

                    return null;
                }
            },

            initSession: async function () {
                let {pk, spk, ik} = await this.getBundle(),
                    cached_pk = this.getPreKey(),
                    id = this.id;
                if (cached_pk) {
                    if (!spk || spk && JSON.stringify(spk) == JSON.stringify(cached_pk.spk) && JSON.stringify(ik) == JSON.stringify(cached_pk.ik))
                        pk = cached_pk.pk;
                    else
                        this.account.omemo.used_prekeys.put({id, pk, spk, ik});
                }
                else
                    this.account.omemo.used_prekeys.put({id, pk, spk, ik});
                this.set({'pk': utils.fromBase64toArrayBuffer(pk.key), 'ik': utils.fromBase64toArrayBuffer(ik)});
                this.fingerprint = this.generateFingerprint();
                let trusted = this.account.omemo.isTrusted(this.jid, this.fingerprint);
                this.set('trusted', trusted);
                if ((this.id != this.account.omemo.get('device_id')) && trusted === false)
                    return false;
                this.processPreKey({
                    registrationId: Number(id),
                    identityKey: utils.fromBase64toArrayBuffer(ik),
                    signedPreKey: {
                        keyId: Number(spk.id),
                        publicKey: utils.fromBase64toArrayBuffer(spk.key),
                        signature: utils.fromBase64toArrayBuffer(spk.signature)
                    },
                    preKey: {
                        keyId: Number(pk.id),
                        publicKey: utils.fromBase64toArrayBuffer(pk.key)
                    }
                });
                return true;
            },

            processPreKey: function (preKeyBundle) {
                this.session = new SessionBuilder(this.store, this.address);
                return this.session.processPreKey(preKeyBundle);
            },

            removeSession: function () {
                this.store.removeSession(this.address.toString());
                this.sessionCipher = null;
            },

            getSession: function () {
                if (!this.sessionCipher) {
                    this.sessionCipher = new SessionCipher(this.store, this.address);
                }
                return this.sessionCipher;
            }
        });

        xabber.Omemo = Backbone.ModelWithStorage.extend({
            defaults: {
                sessions: {},
                fingerprints: {},
                prekeys: {},
                used_prekeys: {},
                own_used_prekeys: {},
                device_id: ""
            },

            _initialize: function (attrs, options) {
                this.on("change:device_id", this.onDeviceIdUpdated, this);
                this.account = options.account;
                this.peers = new xabber.Peers();
                if (!this.get('device_id'))
                    this.set('device_id', this.generateDeviceId());
                this.store = new xabber.SignalProtocolStore();
                this.account.on('device_published', this.publishBundle, this);
                this.store.on('prekey_removed', this.removePreKey, this);
                this.store.on('session_stored', this.cacheSession, this);
            },

            storeSessions: function () {
                let sessions = this.get('sessions');
                for (let session_id in sessions) {
                    let session = sessions[session_id];
                    session && this.store.put(session_id, session);
                }
            },

            onConnected: function () {
                this.prekeys = new xabber.Prekeys({name: 'prekeys', model: this});
                this.used_prekeys = new xabber.Prekeys({name: 'used_prekeys', model: this});
                this.own_used_prekeys = new xabber.Prekeys({name: 'own_used_prekeys', model: this});
                this.cached_messages = new xabber.DecryptedMessages({id: 'decrypted-messages'}, {
                    account: this.account,
                    storage_name: xabber.getStorageName() + '-decrypted-messages-' + this.account.get('jid'),
                    fetch: 'before'
                });
                this.bundle = new xabber.Bundle(null, {store: this.store, model: this});
                this.connection = this.account.connection;
                this.registerMessageHandler();
                this.addDevice();
            },

            getMyTrusted: function () {
                let conn = this.account.connection;
                if (conn) {
                    if (conn.omemo) {
                        if (conn.omemo.devices) {
                            conn.omemo.devices.forEach(function (device) {

                            });
                        } else {
                            conn.omemo.getDevicesNode(null, function (cb) {
                                conn.omemo.devices = conn.omemo.getUserDevices($(cb));
                            }.bind(this));
                        }
                    }
                }
                return false;
            },

            updateFingerprints: function (contact, fingerprint, trusted) {
                let fingerprints = _.clone(this.get('fingerprints'));
                if (!fingerprints[contact])
                    fingerprints[contact] = [];
                let contact_fingerprints = fingerprints[contact],
                    finger = contact_fingerprints.find(f => f.fingerprint == fingerprint),
                    idx = contact_fingerprints.indexOf(finger);
                if (idx >= 0)
                    contact_fingerprints.splice(idx, 1);
                contact_fingerprints.push({fingerprint, trusted});
                this.save('fingerprints', fingerprints);
            },

            isTrusted: function (jid, fingerprint) {
                let fingerprints = _.clone(this.get('fingerprints'));
                if (!fingerprints[jid])
                    return;
                let fing = fingerprints[jid].find(f => f.fingerprint == fingerprint);
                if (fing) {
                    if (fing.trusted === undefined)
                        return;
                    else
                        return fing.trusted;
                }
                else
                    return;

            },

            addDevice: function () {
                let device_id = this.get('device_id');
                if (this.connection) {
                    let omemo = this.connection.omemo;
                    if (omemo.devices.length) {
                        let device = omemo.devices[device_id];
                        if (!device || device && (device.label || this.account.settings.get('device_label_text')) && device.label != this.account.settings.get('device_label_text')) {
                            let label = this.account.settings.get('device_label_text');
                            omemo.publishDevice(device_id, label, function () {
                                this.account.trigger('device_published');
                            }.bind(this));
                        }
                        else
                            this.account.trigger('device_published');
                    }
                    else
                        omemo.getDevicesNode(null, function (cb) {
                            omemo.devices = omemo.getUserDevices($(cb));
                            let device = omemo.devices[device_id];
                            if (!device || device && (device.label || this.account.settings.get('device_label_text')) && device.label != this.account.settings.get('device_label_text')) {
                                let label = this.account.settings.get('device_label_text');
                                omemo.publishDevice(device_id, label, function () {
                                    this.account.trigger('device_published');
                                }.bind(this));
                            }
                            else
                                this.account.trigger('device_published');
                        }.bind(this));
                }
            },

            onDeviceIdUpdated: function () {
                this.save('device_id', this.get('device_id'));
            },

            generateDeviceId: function () {
                let min = 1,
                    max = Math.pow(2, 31) - 1,
                    rand = min + Math.random() * (max + 1 - min);
                return Math.floor(rand);
            },

            updateMessage: function (attrs, contact) {
                if (!this.cached_messages)
                    return;
                this.cached_messages.updateMessage(attrs, contact);
            },

            registerMessageHandler: function () {
                this.account.connection.deleteHandler(this._msg_handler);
                this._msg_handler = this.account.connection.addHandler(function (message) {
                    this.receiveMessage(message);
                    return true;
                }.bind(this), null, 'message', null, null, null, {'encrypted': true});
            },

            encrypt: function (contact, message) {
                let peer = this.getPeer(contact.get('jid')),
                    $msg = $(message.tree()),
                    origin_id = $msg.children('origin-id').attr('id'),
                    plaintext = Strophe.serialize($msg.children('body')[0]) || "";

                $msg.children('reference').each(function (i, ref) {
                    plaintext += Strophe.serialize(ref);
                }.bind(this));

                this.cached_messages.putMessage(contact, origin_id, plaintext);

                return peer.encrypt(plaintext).then((encryptedMessage) => {

                    let encryptedElement = $build('encrypted', {xmlns: Strophe.NS.OMEMO})
                        .c('header', {
                            sid: this.get('device_id'),
                            label: this.account.settings.get('device_label_text')
                        }),
                        myKeys = $build('keys', {jid: this.account.get('jid')});

                    encryptedElement.c('keys', { jid: contact.get('jid')});

                    for (let key of encryptedMessage.keys) {
                        let attrs = {
                            rid: key.deviceId,
                            kex: undefined
                        };
                        if (key.preKey) {
                            attrs.kex = true;
                        }

                        if (peer.devices[key.deviceId]) {
                            encryptedElement.c('key', attrs).t(btoa(key.ciphertext.body)).up();
                            if (key.preKeyMsg) {
                                encryptedElement.c('help', {rid: key.deviceId})
                                    .c('baseKey').t(utils.ArrayBuffertoBase64(key.preKeyMsg.baseKey)).up()
                                    .c('identityKey').t(utils.ArrayBuffertoBase64(key.preKeyMsg.identityKey)).up()
                                    .c('preKeyId').t(key.preKeyMsg.preKeyId).up()
                                    .c('registrationId').t(key.preKeyMsg.registrationId).up()
                                    .c('signedPreKeyId').t(key.preKeyMsg.signedPreKeyId).up().up();
                            } else if (key.session) {
                                encryptedElement.c('help', {rid: key.deviceId})
                                    .c('baseKey').t(utils.ArrayBuffertoBase64(key.session.baseKey)).up()
                                    .c('identityKey').t(utils.ArrayBuffertoBase64(key.session.identityKey)).up()
                                    .c('registrationId').t(key.session.registrationId).up().up();
                            }
                        }
                        else {
                            myKeys.c('key', attrs).t(btoa(key.ciphertext.body)).up();
                            if (key.preKeyMsg) {
                                myKeys.c('help', {rid: key.deviceId})
                                    .c('baseKey').t(utils.ArrayBuffertoBase64(key.preKeyMsg.baseKey)).up()
                                    .c('identityKey').t(utils.ArrayBuffertoBase64(key.preKeyMsg.identityKey)).up()
                                    .c('preKeyId').t(key.preKeyMsg.preKeyId).up()
                                    .c('registrationId').t(key.preKeyMsg.registrationId).up()
                                    .c('signedPreKeyId').t(key.preKeyMsg.signedPreKeyId).up().up();
                            } else if (key.session) {
                                myKeys.c('help', {rid: key.deviceId})
                                    .c('baseKey').t(utils.ArrayBuffertoBase64(key.session.baseKey)).up()
                                    .c('identityKey').t(utils.ArrayBuffertoBase64(key.session.identityKey)).up()
                                    .c('registrationId').t(key.session.registrationId).up().up();
                            }
                        }

                    }
                    encryptedElement.up().cnode(myKeys.tree());

                    encryptedElement.up().c('iv', utils.ArrayBuffertoBase64(encryptedMessage.iv)).up().up()
                        .c('payload').t(utils.ArrayBuffertoBase64(encryptedMessage.payload));

                    $(message.tree()).find('body').remove();
                    $(message.tree()).children('reference').remove();

                    message.cnode(encryptedElement.tree());
                    message.up().c('store', {
                        xmlns: 'urn:xmpp:hints'
                    }).up()
                        .c('body').t('This message is encrypted using OMEMO end-to-end encryption.').up();

                    return {message: message, is_trusted: encryptedMessage.is_trusted};
                }).catch((msg) => {
                    console.log(msg);
                });
            },

            receiveHeadlineMessage: function (message) {
                var $message = $(message),
                    from_jid = Strophe.getBareJidFromJid($message.attr('from')),
                    node = $message.find('items').attr('node');
                if ($message.find('event[xmlns="' + Strophe.NS.PUBSUB + '#event"]').length) {
                    if (node == `${Strophe.NS.OMEMO}:devices`) {
                        let devices = this.account.connection.omemo.getUserDevices($message);
                        if (from_jid === this.account.get('jid')) {
                            this.account.connection.omemo.devices = devices;
                            let device_id = this.account.omemo.get('device_id'),
                                device = this.account.connection.omemo.devices[device_id];
                            if (!device || device && (device.label || this.account.settings.get('device_label_text')) && device.label != this.account.settings.get('device_label_text')) {
                                let label = this.account.settings.get('device_label_text');
                                this.account.connection.omemo.publishDevice(device_id, label, () => {
                                    this.account.trigger('device_published');
                                });
                            }
                            this.account.trigger("devices_updated");
                        }
                        else {
                            this.getPeer(from_jid).updateDevices(devices);
                        }
                        return;
                    }
                    if (node == `${Strophe.NS.OMEMO}:bundles`) {
                        /*let id = $message.find('item').attr('id');
                        this.getPeer(from_jid).getDevice(id);*/
                    }
                }
            },

            receiveChatMessage: function (message, options) {
                options = options || {};
                let $message = $(message);
                if ($message.find(`encrypted[xmlns="${Strophe.NS.OMEMO}"]`).length) {
                    if ($message.find('result[xmlns="' + Strophe.NS.MAM + '"]').length)
                        _.extend(options, {
                            is_mam: true,
                            is_archived: true
                        });
                    if ($message.find('[xmlns="' + Strophe.NS.CARBONS + '"]').length)
                        options.carbon_copied = true;

                    let $msg = $message.find(`encrypted[xmlns="${Strophe.NS.OMEMO}"]`).parent(),
                        jid = (Strophe.getBareJidFromJid($msg.attr('from')) === this.account.get('jid') ? Strophe.getBareJidFromJid($msg.attr('to')) : Strophe.getBareJidFromJid($msg.attr('from'))) || options.from_jid,
                        contact = this.account.contacts.get(jid),
                        stanza_id = $msg.children(`stanza-id[by="${this.account.get('jid')}"]`).attr('id'),
                        cached_msg = stanza_id && this.cached_messages.getMessage(contact, stanza_id);

                    let $help_info = $message.find(`help[rid="${this.get('device_id')}"]`);
                    if ($help_info.length) {
                        let baseKey = $help_info.children('baseKey').text(),
                            identityKey = $help_info.children('identityKey').text(),
                            preKeyId = $help_info.children('preKeyId').text(),
                            registrationId = $help_info.children('registrationId').text(),
                            signedPreKeyId = $help_info.children('signedPreKeyId').text(),
                            $header = $message.find('header'),
                            device_id = $header.attr('sid'),
                            label = $header.attr('label') || "";
                        options.help_info = {baseKey, identityKey, preKeyId, registrationId, signedPreKeyId, device_id, label};
                    }
                    let devices_ids = {};
                    $message.find('keys').each(function (idx, keys) {
                        let $keys = $(keys),
                            jid_devices = [];
                        $keys.children('key').each(function (idx1, key) {
                            jid_devices.push($(key).attr('rid'));
                        }.bind(this));
                        devices_ids[$keys.attr('jid')] = jid_devices;
                    }.bind(this));
                    if (Object.keys(devices_ids).length) {
                        if (options.help_info)
                            options.help_info = _.extend(options.help_info, {all_devices: devices_ids});
                        else
                            options.help_info = {all_devices: devices_ids};
                    }

                    if (cached_msg && !options.replaced) {
                        options.encrypted = true;
                        this.getTrusted($message).then((is_trusted) => {
                            options.is_trusted = is_trusted;
                            $message.find('body').remove();
                            $message.find(`encrypted[xmlns="${Strophe.NS.OMEMO}"]`).replaceWith(cached_msg);
                            this.account.chats.receiveChatMessage($message[0], options);
                        });
                        return;
                    }

                    if (options.replaced) {
                        this.decrypt(message.children('replace').children('message'), options).then((decrypted_msg) => {
                            if (decrypted_msg) {
                                options.encrypted = true;
                                stanza_id && this.cached_messages.putMessage(contact, stanza_id, decrypted_msg);
                                $message.find('body').remove();
                                $message.find(`encrypted[xmlns="${Strophe.NS.OMEMO}"]`).replaceWith(decrypted_msg);
                                let chat = this.account.chats.getChat(contact, 'encrypted');
                                chat && chat.messages.createFromStanza($message, options);
                                let msg_item = chat.messages.find(msg => msg.get('stanza_id') == stanza_id || msg.get('contact_stanza_id') == stanza_id);
                                if (msg_item) {
                                    msg_item.set('last_replace_time', $message.find('replaced').attr('stamp'));
                                    chat && chat.item_view.updateLastMessage(chat.last_message);
                                }
                            }
                        });
                    } else {
                        this.getTrusted($message).then((is_trusted) => {
                            options.is_trusted = is_trusted;
                            return this.decrypt(message);
                        }).then((decrypted_msg) => {
                            if (decrypted_msg) {
                                options.encrypted = true;
                                stanza_id && this.cached_messages.putMessage(contact, stanza_id, decrypted_msg);
                                $message.find('body').remove();
                            }
                            else {
                                options.not_encrypted = true;
                                delete options.is_trusted;
                            }
                            $message.find(`encrypted[xmlns="${Strophe.NS.OMEMO}"]`).replaceWith(decrypted_msg);
                            this.account.chats.receiveChatMessage($message[0], options);
                        }).catch(() => {
                            options.not_encrypted = true;
                            delete options.is_trusted;
                            $message.find(`encrypted[xmlns="${Strophe.NS.OMEMO}"]`).remove();
                            this.account.chats.receiveChatMessage($message[0], options);
                        });
                    }
                }
            },

            getTrusted: async function ($message) {
                let device_id = $message.find(`encrypted[xmlns="${Strophe.NS.OMEMO}"] header`).attr('sid'),
                    $msg = $message.find(`encrypted[xmlns="${Strophe.NS.OMEMO}"]`).parent(),
                    jid = Strophe.getBareJidFromJid($msg.attr('from')),
                    peer = this.getPeer(jid),
                    device = peer.getDevice(device_id), fingerprint;
                if (device_id == this.get('device_id'))
                    return true;
                if (device.fingerprint) {
                    return this.isTrusted(jid, device.fingerprint);
                } else {
                    if (device.get('ik')) {
                        fingerprint = device.generateFingerprint();
                    }
                    else {
                        let {pk, spk, ik} = await device.getBundle();
                        device.set('ik', utils.fromBase64toArrayBuffer(ik));
                        fingerprint = device.generateFingerprint();
                    }
                    return this.isTrusted(jid, fingerprint);
                }
            },

            receiveMessage: function (message) {
                let $message = $(message),
                    type = $message.attr('type');
                if (type === 'headline') {
                    return this.receiveHeadlineMessage(message);
                }
            },

            parseEncrypted: function ($encrypted) {
                let $payload = $encrypted.children(`payload`),
                    $header = $encrypted.children('header'),
                    iv = utils.fromBase64toArrayBuffer($header.find('iv').text()),
                    payload = utils.fromBase64toArrayBuffer($payload.text()),
                    sid = Number($header.attr('sid'));

                let keys = $header.find(`key`).get().map(function(keyElement) {
                    return {
                        preKey: $(keyElement).attr('kex') === 'true',
                        ciphertext: utils.fromBase64toArrayBuffer($(keyElement).text()),
                        deviceId: parseInt($(keyElement).attr('rid'))
                    };
                });

                return {sid, keys, iv, payload};
            },

            getPeer: function (jid) {
                if (!this.peers.get(jid))
                    this.peers.create({jid}, {account:this.account});
                return this.peers.get(jid);
            },

            decrypt: async function (message, options) {
                let $message = $(message),
                    from_jid = Strophe.getBareJidFromJid($message.attr('from')) || options.from_jid,
                    $encrypted;

                if ($message.find('result[xmlns="'+Strophe.NS.MAM+'"]').length) {
                    let $m = $message.find('message').first();
                    from_jid = Strophe.getBareJidFromJid($m.attr('from'));
                    $encrypted = $message.children(`result`).children(`forwarded`).children(`message`).children(`encrypted[xmlns="${Strophe.NS.OMEMO}"]`);
                }
                else if ($message.find('[xmlns="'+Strophe.NS.CARBONS+'"]').length)
                    $encrypted = $message.children(`[xmlns="${Strophe.NS.CARBONS}"]`).children(`forwarded`).children(`message`).children(`encrypted[xmlns="${Strophe.NS.OMEMO}"]`);
                else
                    $encrypted = $message.children(`encrypted[xmlns="${Strophe.NS.OMEMO}"]`);

                let encryptedData = this.parseEncrypted($encrypted),
                    deviceId = this.get('device_id'),
                    ownPreKeysArr =  encryptedData.keys.filter(preKey => preKey.deviceId == deviceId),
                    ownPreKey = ownPreKeysArr[0];
                if (!ownPreKey)
                    return;
                let peer = this.getPeer(from_jid),
                    exportedKey = await peer.decrypt(encryptedData.sid, ownPreKey.ciphertext, ownPreKey.preKey);
                if (!exportedKey)
                    return;
                let exportedAESKey = exportedKey.slice(0, 16),
                    authenticationTag = exportedKey.slice(16),
                    iv = encryptedData.iv,
                    ciphertextAndAuthenticationTag = utils.AES.arrayBufferConcat(encryptedData.payload, authenticationTag);

                return utils.AES.decrypt(exportedAESKey, iv, ciphertextAndAuthenticationTag);
            },

            toBase64: function (arrayBuffer) {
                return btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
            },

            publish: function (spk, ik, pks) {
                if (!this.account.connection)
                    return;
                let conn_omemo = this.account.connection.omemo,
                    prekeys = [];
                pks.forEach(function (pk) {
                    let id = pk.keyId,
                        pubKey = utils.ArrayBuffertoBase64(pk.keyPair.pubKey),
                        privKey = utils.ArrayBuffertoBase64(pk.keyPair.privKey),
                        key = JSON.stringify({pubKey, privKey});
                    if (!pk.signature) {
                        prekeys.push({id: id, key: pubKey});
                        this.prekeys.put({id, key});
                    }
                }.bind(this));
                conn_omemo.publishBundle({
                    spk: {id: spk.keyId, key: utils.ArrayBuffertoBase64(spk.keyPair.pubKey)},
                    spks: utils.ArrayBuffertoBase64(spk.signature),
                    ik:  utils.ArrayBuffertoBase64(ik),
                    pks: prekeys,
                    device_id: this.get('device_id')
                });
            },

            removePreKey: async function (id) {
                if (!this.account)
                    return;
                let bundle = this.bundle,
                    removed_pk = this.bundle.preKeys.find(p => p.keyId === id && !p.signature);
                if (!removed_pk)
                    return;
                let pubKey = utils.ArrayBuffertoBase64(removed_pk.keyPair.pubKey),
                    privKey = utils.ArrayBuffertoBase64(removed_pk.keyPair.privKey),
                    key = JSON.stringify({pubKey, privKey}),
                    idx = this.bundle.preKeys.indexOf(removed_pk);
                bundle.preKeys.splice(idx, 1);
                this.own_used_prekeys.put({id, key});
                this.prekeys.remove(id);
                if (bundle.preKeys.length && bundle.preKeys.length < constants.MIN_PREKEYS_COUNT) {
                    let missing_keys = constants.PREKEYS_COUNT - bundle.preKeys.length,
                        last_id = _.sortBy(xabber.accounts.connected[0].omemo.bundle.preKeys, 'keyId').last().keyId;
                    for (var i = ++last_id; last_id + missing_keys; i++)
                        await this.bundle.generatePreKey(i);
                    this.account.omemo.publishBundle();
                }
                else
                    this.account.omemo.publishBundle();
            },

            cacheSession: function (attrs) {
                let id = attrs.id,
                    session = attrs.rec,
                    sessions = _.clone(this.get('sessions'));
                _.isArray(sessions) && (sessions = {});
                sessions[id] = session;
                this.save('sessions', sessions);
            },

            getSession: function (id) {
                let sessions = _.clone(this.get('sessions'));
                return sessions[id];
            },

            publishBundle: async function () {
                let spk = this.bundle.preKeys.find(pk => pk.signature),
                    ik = await this.store.getIdentityKeyPair(),
                    pks = this.bundle.preKeys;
                if (!spk || !ik) {
                    this.set('resend_bundle', true);
                    return;
                }
                this.account.connection.omemo.getBundleInfo({jid: this.account.get('jid'), id: this.get('device_id')}, function () {
                        this.publish(spk, ik.pubKey, pks);
                    }.bind(this),
                    function (err) {
                        if (($(err).find('error').attr('code') == 404))
                            this.account.connection.omemo.createBundleNode(this.get('device_id'), function () {
                                this.publish(spk, ik.pubKey, pks);
                            }.bind(this));
                    }.bind(this));
            }
        });

        xabber.DecryptedMessages = Backbone.ModelWithStorage.extend({
            defaults: {
                messages: {}
            },

            getMessage: function (contact, stanza_id) {
                let messages = _.clone(this.get('messages')),
                    contact_messages = messages[contact.get('jid')] || {};
                return contact_messages[stanza_id];
            },

            putMessage: function (contact, stanza_id, message) {
                let messages = _.clone(this.get('messages')),
                    contact_messages = messages[contact.get('jid')] || {};
                contact_messages[stanza_id] = message;
                messages[contact.get('jid')] = contact_messages;
                this.save('messages', messages);
            },

            removeMessage: function (attrs, contact) {
                let origin_id = attrs.origin_id;
                let messages = _.clone(this.get('messages')),
                    contact_messages = messages[contact.get('jid')] || {};
                delete contact_messages[origin_id];
                messages[contact.get('jid')] = contact_messages;
                this.save('messages', messages);
            },

            updateMessage: function (attrs, contact) {
                let stanza_id = attrs.stanza_id,
                    origin_id = attrs.origin_id,
                    messages = _.clone(this.get('messages')),
                    contact_messages = messages[contact.get('jid')] || {},
                    message = contact_messages[origin_id];
                if (origin_id)
                    this.removeMessage({origin_id}, contact);
                if (stanza_id)
                    this.putMessage(contact, stanza_id, message);
            }
        });

        xabber.SignalProtocolStore = Backbone.Model.extend({
            initialize: function () {
                this.Direction = {
                    SENDING: 1,
                    RECEIVING: 2
                };
                this.store = {};
            },

            getIdentityKeyPair: function () {
                return Promise.resolve(this.get('identityKey'));
            },

            getLocalRegistrationId: function () {
                return Promise.resolve(this.get('registrationId'));
            },

            put: function (key, value) {
                if (key === undefined || value === undefined || key === null || value === null)
                    throw new Error("Tried to store undefined/null");
                this.store[key] = value;
            },

            get: function (key, defaultValue) {
                if (key === null || key === undefined)
                    throw new Error("Tried to get value for undefined/null key");
                if (key in this.store) {
                    return this.store[key];
                } else {
                    return defaultValue;
                }
            },

            remove: function (key) {
                if (key === null || key === undefined)
                    throw new Error("Tried to remove value for undefined/null key");
                delete this.store[key];
            },

            isTrustedIdentity: function (identifier, identityKey, direction) {
                if (identifier === null || identifier === undefined) {
                    throw new Error("tried to check identity key for undefined/null key");
                }
                if (!(identityKey instanceof ArrayBuffer)) {
                    throw new Error("Expected identityKey to be an ArrayBuffer");
                }
                var trusted = this.get('identityKey' + identifier);
                if (trusted === undefined) {
                    return Promise.resolve(true);
                }
                return Promise.resolve(util.toString(identityKey) === util.toString(trusted));
            },

            loadIdentityKey: function (identifier) {
                if (identifier === null || identifier === undefined)
                    throw new Error("Tried to get identity key for undefined/null key");
                return Promise.resolve(this.get('identityKey' + identifier));
            },

            saveIdentity: function (identifier, identityKey) {
                if (identifier === null || identifier === undefined)
                    throw new Error("Tried to put identity key for undefined/null key");

                var address = new SignalProtocolAddress.fromString(identifier);

                var existing = this.get('identityKey' + address.getName());
                this.put('identityKey' + address.getName(), identityKey);

                if (existing && libsignal.toString(identityKey) !== libsignal.toString(existing)) {
                    return Promise.resolve(true);
                } else {
                    return Promise.resolve(false);
                }

            },

            /* Returns a prekeypair object or undefined */
            loadPreKey: function (keyId) {
                var res = this.get('25519KeypreKey' + keyId);
                if (res !== undefined) {
                    res = {pubKey: res.pubKey, privKey: res.privKey};
                }
                return Promise.resolve(res);
            },

            storePreKey: function (keyId, keyPair) {
                return Promise.resolve(this.put('25519KeypreKey' + keyId, keyPair));
            },

            removePreKey: function (keyId) {
                this.trigger('prekey_removed', keyId);
                // return Promise.resolve(this.remove('25519KeypreKey' + keyId));
            },

            /* Returns a signed keypair object or undefined */
            loadSignedPreKey: function (keyId) {
                var res = this.get('25519KeysignedKey' + keyId);
                if (res !== undefined) {
                    res = {pubKey: res.pubKey, privKey: res.privKey};
                }
                return Promise.resolve(res);
            },

            storeSignedPreKey: function (keyId, keyPair) {
                return Promise.resolve(this.put('25519KeysignedKey' + keyId, keyPair));
            },

            removeSignedPreKey: function (keyId) {
                return Promise.resolve(this.remove('25519KeysignedKey' + keyId));
            },

            loadSession: function (identifier) {
                return Promise.resolve(this.get('session' + identifier));
            },

            hasSession: function (identifier) {
                return !!this.get('session' + identifier)
            },

            storeSession: function (identifier, record) {
                this.trigger('session_stored', {id: 'session' + identifier, rec: record});
                return Promise.resolve(this.put('session' + identifier, record));
            },

            removeSession: function (identifier) {
                return Promise.resolve(this.remove('session' + identifier));
            },

            getAllSessions: function (identifier) {
                let sessions = [];
                for (var id in this.store) {
                    if (id.startsWith('session' + identifier)) {
                        sessions.push({id: id, session: this.store[id]});
                    }
                }
                return Promise.resolve(sessions);
            },

            removeAllSessions: function (identifier) {
                for (var id in this.store) {
                    if (id.startsWith('session' + identifier)) {
                        delete this.store[id];
                    }
                }
                return Promise.resolve();
            }
        });

        xabber.Account.addInitPlugin(function () {
            if (!this.settings.get('omemo'))
                return;
            this.omemo = new xabber.Omemo({id: 'omemo'}, {
                account: this,
                storage_name: xabber.getStorageName() + '-omemo-settings-' + this.get('jid'),
                fetch: 'before'
            });
        });

        xabber.Account.addConnPlugin(function () {
            if (!this.settings.get('omemo'))
                return;
            this.omemo.onConnected();
        }, true, true);

        return xabber;
    };
});