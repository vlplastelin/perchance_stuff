// WebRTC Chat API using jsonblob for signaling
class WebRTCChatAPI {
    constructor() {
        this.roomid = null;
        this.isHost = false;
        this.peerConnections = new Map(); // client_id -> RTCPeerConnection
        this.dataChannels = new Map(); // client_id -> DataChannel
        this.onMessageCallback = null;
        this.onClientConnectedCallback = null;
        this.onConnectedCallback = null;
        this.onHostReadyCallback = null;
        this.onClientReadyCallback = null;
        this.pollingInterval = null;
        this.blobData = null;
        this.clientId = null; // for client
        this.offers = new Map(); // offer_id -> {pc, ice: []}
    }

    async startHost(roomid = null) {
        this.isHost = true;
        this.clientId = 'host';
        let finalRoomId;

        try {
            if (roomid) {
                const response = await fetch(`https://jsonblob.com/api/jsonBlob/${roomid}`);
                if (response.ok) {
                    const data = await response.json();
                    if (this.isValidBlobData(data)) {
                        this.blobData = data;
                        this.roomid = roomid;
                        finalRoomId = roomid;
                    } else {
                        throw new Error('Invalid room data');
                    }
                } else {
                    throw new Error('Room not found');
                }
            } else {
                throw new Error('No roomid provided');
            }
        } catch (e) {
            console.warn('Failed to join room, creating new:', e.message);
            // Create new room
            const response = await fetch('https://jsonblob.com/api/jsonBlob', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ offers: [], client_answers: [] })
            });
            if (response.ok) {
                const data = await this.parseResponse(response);
                this.roomid = data;
                this.blobData = { offers: [], client_answers: [] };
                finalRoomId = data;
            } else {
                throw new Error('Failed to create room');
            }
        }

        console.log('Host started, roomid:', this.roomid);
        if (this.onHostReadyCallback) this.onHostReadyCallback();
        return finalRoomId;
    }

    async startClient(roomid) {
        if (!roomid) {
            throw new Error('Room ID is required for client');
        }
        this.roomid = roomid;
        this.isHost = false;
        this.clientId = Math.random().toString(36).substr(2, 9);

        try {
            const response = await fetch(`https://jsonblob.com/api/jsonBlob/${roomid}`);
            if (response.ok) {
                const data = await response.json();
                if (this.isValidBlobData(data)) {
                    this.blobData = data;
                    console.log('Client joined room:', roomid);
                    if (this.onClientReadyCallback) this.onClientReadyCallback();
                } else {
                    throw new Error('Invalid room data');
                }
            } else {
                throw new Error('Room not found');
            }
        } catch (e) {
            throw new Error('Error starting client: ' + e.message);
        }
    }

    isValidBlobData(data) {
        return data && typeof data === 'object' && Array.isArray(data.offers) && Array.isArray(data.client_answers);
    }

    async parseResponse(response) {
        try {
            const data = await response.json();
            const id = data.id || data;
            return typeof id === 'string' ? id.trim() : String(id).trim();
        } catch {
            const text = await response.text();
            return text.trim();
        }
    }

    async startLookingForClients(duration, interval) {
        if (!this.isHost) return;
        this.stopPolling();
        const endTime = Date.now() + duration;
        this.pollingInterval = setInterval(async () => {
            if (Date.now() > endTime) {
                this.stopPolling();
                return;
            }
            try {
                const response = await fetch(`https://jsonblob.com/api/jsonBlob/${this.roomid}`);
                if (response.ok) {
                    const data = await response.json();
                    if (this.isValidBlobData(data)) {
                        this.blobData = data;
                        const newAnswers = data.client_answers.filter(ans => !this.peerConnections.has(ans.client_id));
                        for (const ans of newAnswers) {
                            await this.handleClientAnswer(ans);
                        }
                    }
                }
            } catch (e) {
                console.error('Error polling for clients:', e);
            }
        }, interval);
    }

    async tryConnecting(duration, interval) {
        if (this.isHost) return;
        this.stopPolling();
        const endTime = Date.now() + duration;
        this.pollingInterval = setInterval(async () => {
            if (Date.now() > endTime) {
                this.stopPolling();
                return;
            }
            try {
                const response = await fetch(`https://jsonblob.com/api/jsonBlob/${this.roomid}`);
                if (response.ok) {
                    const data = await response.json();
                    if (this.isValidBlobData(data)) {
                        this.blobData = data;
                        const newOffers = data.offers.filter(offer => !this.offers.has(offer.id));
                        if (newOffers.length > 0) {
                            await this.handleHostOffer(newOffers[0], data);
                        }
                    }
                }
            } catch (e) {
                console.error('Error trying to connect:', e);
            }
        }, interval);
    }

    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    async handleClientAnswer(ans) {
        const offerData = this.offers.get(ans.offer_id);
        if (!offerData) return;
        const pc = offerData.pc;
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                offerData.ice.push(event.candidate);
                this.updateBlob();
            }
        };
        pc.ondatachannel = (event) => {
            const channel = event.channel;
            this.dataChannels.set(ans.client_id, channel);
            channel.onmessage = (event) => {
                if (this.onMessageCallback) {
                    this.onMessageCallback(event.data, ans.client_id);
                }
            };
            channel.onopen = () => {
                if (this.onClientConnectedCallback) {
                    this.onClientConnectedCallback(ans.client_id);
                }
            };
        };
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: ans.answer }));
            if (ans.ice) {
                for (const candidate of ans.ice) {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }
            }
            this.peerConnections.set(ans.client_id, pc);
        } catch (e) {
            console.error('Error handling client answer:', e);
        }
    }

    async handleHostOffer(offer, data) {
        const pc = new RTCPeerConnection();
        this.peerConnections.set('host', pc);
        pc.onicecandidate = async (event) => {
            if (event.candidate) {
                const updateData = { ...data };
                const ans = updateData.client_answers.find(a => a.offer_id === offer.id && a.client_id === this.clientId);
                if (ans) {
                    ans.ice.push(event.candidate);
                    await this.updateBlob(updateData);
                }
            }
        };
        const channel = pc.createDataChannel('chat');
        this.dataChannels.set('host', channel);
        channel.onmessage = (event) => {
            if (this.onMessageCallback) {
                this.onMessageCallback(event.data, 'host');
            }
        };
        channel.onopen = () => {
            if (this.onConnectedCallback) {
                this.onConnectedCallback();
            }
        };
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offer.offer }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            const updateData = { ...data };
            updateData.client_answers.push({ offer_id: offer.id, client_id: this.clientId, answer: answer.sdp, ice: [] });
            await this.updateBlob(updateData);
            if (offer.ice) {
                for (const candidate of offer.ice) {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }
            }
        } catch (e) {
            console.error('Error handling host offer:', e);
        }
    }

    async updateBlob(data = null) {
        if (!data) data = this.blobData;
        try {
            await fetch(`https://jsonblob.com/api/jsonBlob/${this.roomid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } catch (e) {
            console.error('Error updating blob:', e);
        }
    }

    sendMessage(message, options = {}) {
        if (!message) return;
        if (this.isHost) {
            if (options.toId) {
                const channel = this.dataChannels.get(options.toId);
                if (channel && channel.readyState === 'open') {
                    channel.send(message);
                }
            } else if (options.excludeId) {
                for (const [id, channel] of this.dataChannels) {
                    if (id !== options.excludeId && channel.readyState === 'open') {
                        channel.send(message);
                    }
                }
            } else {
                for (const [id, channel] of this.dataChannels) {
                    if (channel.readyState === 'open') {
                        channel.send(message);
                    }
                }
            }
        } else {
            const channel = this.dataChannels.get('host');
            if (channel && channel.readyState === 'open') {
                channel.send(message);
            }
        }
    }

    onMessage(callback) {
        this.onMessageCallback = callback;
    }

    onClientConnected(callback) {
        this.onClientConnectedCallback = callback;
    }

    onConnected(callback) {
        this.onConnectedCallback = callback;
    }

    onHostReady(callback) {
        this.onHostReadyCallback = callback;
    }

    onClientReady(callback) {
        this.onClientReadyCallback = callback;
    }

    async addOffer() {
        if (!this.isHost) return;
        const offerId = Math.random().toString(36).substr(2, 9);
        const pc = new RTCPeerConnection();
        this.offers.set(offerId, { pc, ice: [] });
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.offers.get(offerId).ice.push(event.candidate);
                this.updateBlob();
            }
        };
        const channel = pc.createDataChannel('chat');
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.blobData.offers.push({ id: offerId, offer: offer.sdp, ice: [] });
            await this.updateBlob();
        } catch (e) {
            console.error('Error adding offer:', e);
        }
    }
}

// Expose globally
window.WebRTCChatAPI = WebRTCChatAPI;
