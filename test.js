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

    async startHost(roomid) {
        this.roomid = roomid;
        this.isHost = true;
        this.clientId = 'host';
        // Fetch or create blob
        if (roomid) {
            const response = await fetch(`https://jsonblob.com/api/jsonBlob/${roomid}`);
            if (response.ok) {
                this.blobData = await response.json();
            } else {
                throw new Error('Room not found');
            }
        } else {
            // Create new blob
            const response = await fetch('https://jsonblob.com/api/jsonBlob', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ offers: [], client_answers: [] })
            });
            if (response.ok) {
                const data = await response.json();
                this.roomid = data.id;
                this.blobData = { offers: [], client_answers: [] };
            } else {
                throw new Error('Failed to create room');
            }
        }
        console.log('Host started, roomid:', this.roomid);
        if (this.onHostReadyCallback) this.onHostReadyCallback();
    }

    async startClient(roomid) {
        this.roomid = roomid;
        this.isHost = false;
        this.clientId = Math.random().toString(36).substr(2, 9);
        const response = await fetch(`https://jsonblob.com/api/jsonBlob/${roomid}`);
        if (response.ok) {
            this.blobData = await response.json();
        } else {
            throw new Error('Room not found');
        }
        console.log('Client started, roomid:', this.roomid);
        if (this.onClientReadyCallback) this.onClientReadyCallback();
    }

    async startLookingForClients(duration, interval) {
        if (!this.isHost) return;
        const endTime = Date.now() + duration;
        this.pollingInterval = setInterval(async () => {
            if (Date.now() > endTime) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
                return;
            }
            try {
                const response = await fetch(`https://jsonblob.com/api/jsonBlob/${this.roomid}`);
                if (response.ok) {
                    const data = await response.json();
                    // Check for new client answers
                    const newAnswers = data.client_answers.filter(ans => !this.peerConnections.has(ans.client_id));
                    for (const ans of newAnswers) {
                        await this.handleClientAnswer(ans);
                    }
                }
            } catch (e) {
                console.error('Error polling for clients:', e);
            }
        }, interval);
    }

    async tryConnecting(duration, interval) {
        if (this.isHost) return;
        const endTime = Date.now() + duration;
        this.pollingInterval = setInterval(async () => {
            if (Date.now() > endTime) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
                return;
            }
            try {
                const response = await fetch(`https://jsonblob.com/api/jsonBlob/${this.roomid}`);
                if (response.ok) {
                    const data = await response.json();
                    // Check for new offers
                    const newOffers = data.offers.filter(offer => !this.offers.has(offer.id));
                    if (newOffers.length > 0) {
                        // Pick the first new offer
                        const offer = newOffers[0];
                        await this.handleHostOffer(offer, data);
                    }
                }
            } catch (e) {
                console.error('Error trying to connect:', e);
            }
        }, interval);
    }

    async handleClientAnswer(ans) {
        const offerData = this.offers.get(ans.offer_id);
        if (!offerData) return;
        const pc = offerData.pc;
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                offerData.ice.push(event.candidate);
                // Update blob
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
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: ans.answer }));
        // Add ICE candidates
        if (ans.ice) {
            for (const candidate of ans.ice) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
        }
        this.peerConnections.set(ans.client_id, pc);
    }

    async handleHostOffer(offer, data) {
        const pc = new RTCPeerConnection();
        this.peerConnections.set('host', pc);
        pc.onicecandidate = async (event) => {
            if (event.candidate) {
                // Update blob with client ice for this offer
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
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offer.offer }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        // Update blob with answer
        const updateData = { ...data };
        updateData.client_answers.push({ offer_id: offer.id, client_id: this.clientId, answer: answer.sdp, ice: [] });
        await this.updateBlob(updateData);
        // Add host ICE
        if (offer.ice) {
            for (const candidate of offer.ice) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
        }
    }

    async updateBlob(data) {
        if (!data) data = this.blobData;
        await fetch(`https://jsonblob.com/api/jsonBlob/${this.roomid}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    }

    sendMessage(message, options = {}) {
        if (this.isHost) {
            if (options.toId) {
                // Send to specific client
                const channel = this.dataChannels.get(options.toId);
                if (channel && channel.readyState === 'open') {
                    channel.send(message);
                }
            } else if (options.excludeId) {
                // Send to all except excludeId
                for (const [id, channel] of this.dataChannels) {
                    if (id !== options.excludeId && channel.readyState === 'open') {
                        channel.send(message);
                    }
                }
            } else {
                // Send to all clients
                for (const [id, channel] of this.dataChannels) {
                    if (channel.readyState === 'open') {
                        channel.send(message);
                    }
                }
            }
        } else {
            // Client sends to host
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

    // For host to add a new offer for a new client
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
        // Note: data channel setup will be in handleClientAnswer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.blobData.offers.push({ id: offerId, offer: offer.sdp, ice: [] });
        await this.updateBlob();
    }
}

// Expose globally
window.WebRTCChatAPI = WebRTCChatAPI;
