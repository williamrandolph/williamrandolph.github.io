class GameDatabase {
    constructor() {
        this.dbName = 'BoardGameGeoDB';
        this.dbVersion = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                this.createSchema(db);
            };
        });
    }

    createSchema(db) {
        // Games store
        if (!db.objectStoreNames.contains('games')) {
            const gamesStore = db.createObjectStore('games', { keyPath: 'id' });
            gamesStore.createIndex('name', 'name', { unique: false });
            gamesStore.createIndex('yearPublished', 'yearPublished', { unique: false });
            gamesStore.createIndex('rating', 'rating.average', { unique: false });
            gamesStore.createIndex('bggRank', 'bggRank', { unique: false });
        }

        // Locations store
        if (!db.objectStoreNames.contains('locations')) {
            const locationsStore = db.createObjectStore('locations', { keyPath: 'id', autoIncrement: true });
            locationsStore.createIndex('locationString', 'locationString', { unique: false });
            locationsStore.createIndex('type', 'type', { unique: false });
            locationsStore.createIndex('coordinates', ['lat', 'lng'], { unique: false });
            locationsStore.createIndex('confidence', 'confidence', { unique: false });
        }

        // Game-Location relationships store
        if (!db.objectStoreNames.contains('gameLocations')) {
            const gameLocationsStore = db.createObjectStore('gameLocations', { keyPath: 'id', autoIncrement: true });
            gameLocationsStore.createIndex('gameId', 'gameId', { unique: false });
            gameLocationsStore.createIndex('locationId', 'locationId', { unique: false });
            gameLocationsStore.createIndex('familyId', 'familyId', { unique: false });
        }

        // Geocoding cache store
        if (!db.objectStoreNames.contains('geocodingCache')) {
            const cacheStore = db.createObjectStore('geocodingCache', { keyPath: 'key' });
            cacheStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Import jobs store (for tracking bulk imports)
        if (!db.objectStoreNames.contains('importJobs')) {
            const jobsStore = db.createObjectStore('importJobs', { keyPath: 'id', autoIncrement: true });
            jobsStore.createIndex('status', 'status', { unique: false });
            jobsStore.createIndex('createdAt', 'createdAt', { unique: false });
        }
    }

    async saveGame(gameData) {
        const transaction = this.db.transaction(['games'], 'readwrite');
        const store = transaction.objectStore('games');
        
        const gameRecord = {
            id: gameData.id,
            bggRank: gameData.bggRank,
            name: gameData.name,
            yearPublished: gameData.yearPublished,
            description: gameData.description,
            minPlayers: gameData.minPlayers,
            maxPlayers: gameData.maxPlayers,
            playingTime: gameData.playingTime,
            families: gameData.families,
            categories: gameData.categories,
            mechanics: gameData.mechanics,
            rating: gameData.rating,
            updatedAt: new Date().toISOString()
        };

        return new Promise((resolve, reject) => {
            const request = store.put(gameRecord);
            request.onsuccess = () => resolve(gameRecord);
            request.onerror = () => reject(request.error);
        });
    }

    async saveLocation(locationData) {
        const transaction = this.db.transaction(['locations'], 'readwrite');
        const store = transaction.objectStore('locations');
        
        const locationRecord = {
            locationString: locationData.locationString,
            type: locationData.type,
            lat: locationData.geocoded.lat,
            lng: locationData.geocoded.lng,
            displayName: locationData.geocoded.displayName,
            confidence: locationData.geocoded.confidence,
            boundingBox: locationData.geocoded.boundingBox,
            address: locationData.geocoded.address,
            familyName: locationData.familyName,
            createdAt: new Date().toISOString()
        };

        return new Promise((resolve, reject) => {
            const request = store.add(locationRecord);
            request.onsuccess = () => {
                locationRecord.id = request.result;
                resolve(locationRecord);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async saveGameLocation(gameId, locationId, familyId) {
        const transaction = this.db.transaction(['gameLocations'], 'readwrite');
        const store = transaction.objectStore('gameLocations');
        
        const relationRecord = {
            gameId: gameId,
            locationId: locationId,
            familyId: familyId,
            createdAt: new Date().toISOString()
        };

        return new Promise((resolve, reject) => {
            const request = store.add(relationRecord);
            request.onsuccess = () => {
                relationRecord.id = request.result;
                resolve(relationRecord);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async saveGameWithLocations(gameWithLocations) {
        // Save the game first
        const savedGame = await this.saveGame(gameWithLocations);
        
        // Save locations and create relationships
        const savedLocations = [];
        for (const location of gameWithLocations.locations) {
            if (location.geocoded.success) {
                try {
                    const savedLocation = await this.saveLocation(location);
                    await this.saveGameLocation(savedGame.id, savedLocation.id, location.familyId);
                    savedLocations.push(savedLocation);
                } catch (error) {
                    console.error(`Error saving location for game ${savedGame.id}:`, error);
                }
            }
        }

        return {
            game: savedGame,
            locations: savedLocations,
            stats: gameWithLocations.geocodingStats
        };
    }

    async getGame(gameId) {
        const transaction = this.db.transaction(['games'], 'readonly');
        const store = transaction.objectStore('games');
        
        return new Promise((resolve, reject) => {
            const request = store.get(gameId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getGameWithLocations(gameId) {
        const game = await this.getGame(gameId);
        if (!game) return null;

        const locations = await this.getLocationsForGame(gameId);
        
        return {
            ...game,
            locations: locations
        };
    }

    async getLocationsForGame(gameId) {
        const transaction = this.db.transaction(['gameLocations', 'locations'], 'readonly');
        const gameLocationsStore = transaction.objectStore('gameLocations');
        const locationsStore = transaction.objectStore('locations');
        
        return new Promise((resolve, reject) => {
            const locations = [];
            const index = gameLocationsStore.index('gameId');
            const request = index.openCursor(gameId);
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const gameLocation = cursor.value;
                    
                    // Get the actual location data
                    const locationRequest = locationsStore.get(gameLocation.locationId);
                    locationRequest.onsuccess = () => {
                        if (locationRequest.result) {
                            locations.push({
                                ...locationRequest.result,
                                familyId: gameLocation.familyId
                            });
                        }
                        cursor.continue();
                    };
                } else {
                    resolve(locations);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    async getAllGamesWithLocations() {
        // First get all games
        const transaction1 = this.db.transaction(['games'], 'readonly');
        const gamesStore = transaction1.objectStore('games');
        
        const allGames = await new Promise((resolve, reject) => {
            const games = [];
            const request = gamesStore.openCursor();
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    games.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(games);
                }
            };
            
            request.onerror = () => reject(request.error);
        });

        // Then get locations for each game
        const gamesWithLocations = [];
        for (const game of allGames) {
            const locations = await this.getLocationsForGame(game.id);
            if (locations.length > 0) {
                gamesWithLocations.push({
                    ...game,
                    locations: locations
                });
            }
        }

        return gamesWithLocations;
    }

    async searchGames(query) {
        const transaction = this.db.transaction(['games'], 'readonly');
        const store = transaction.objectStore('games');
        
        return new Promise((resolve, reject) => {
            const games = [];
            const request = store.openCursor();
            const queryLower = query.toLowerCase();
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const game = cursor.value;
                    if (game.name.toLowerCase().includes(queryLower)) {
                        games.push(game);
                    }
                    cursor.continue();
                } else {
                    resolve(games);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    async getStats() {
        const transaction = this.db.transaction(['games', 'locations', 'gameLocations'], 'readonly');
        
        const gameCount = await this.getObjectCount(transaction.objectStore('games'));
        const locationCount = await this.getObjectCount(transaction.objectStore('locations'));
        const relationCount = await this.getObjectCount(transaction.objectStore('gameLocations'));
        
        return {
            games: gameCount,
            locations: locationCount,
            relationships: relationCount,
            gamesWithLocations: relationCount > 0 ? await this.getGamesWithLocationsCount() : 0
        };
    }

    async getObjectCount(store) {
        return new Promise((resolve, reject) => {
            const request = store.count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getGamesWithLocationsCount() {
        const transaction = this.db.transaction(['gameLocations'], 'readonly');
        const store = transaction.objectStore('gameLocations');
        
        return new Promise((resolve, reject) => {
            const gameIds = new Set();
            const request = store.openCursor();
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    gameIds.add(cursor.value.gameId);
                    cursor.continue();
                } else {
                    resolve(gameIds.size);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    async clearAllData() {
        const transaction = this.db.transaction(['games', 'locations', 'gameLocations', 'geocodingCache', 'importJobs'], 'readwrite');
        
        const stores = ['games', 'locations', 'gameLocations', 'geocodingCache', 'importJobs'];
        const promises = stores.map(storeName => {
            const store = transaction.objectStore(storeName);
            return new Promise((resolve, reject) => {
                const request = store.clear();
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        });
        
        return Promise.all(promises);
    }

    async linkGameToLocation(gameId, locationId, metadata = {}) {
        const transaction = this.db.transaction(['gameLocations'], 'readwrite');
        const store = transaction.objectStore('gameLocations');
        
        const linkRecord = {
            gameId: gameId,
            locationId: locationId,
            familyId: metadata.familyId || null,
            source: metadata.source || 'manual',
            matchType: metadata.matchType || 'unknown',
            confidence: metadata.confidence || 0.5,
            score: metadata.score || 0,
            approved: metadata.approved || false,
            createdAt: new Date().toISOString()
        };

        return new Promise((resolve, reject) => {
            const request = store.add(linkRecord);
            request.onsuccess = () => resolve(linkRecord);
            request.onerror = () => reject(request.error);
        });
    }
}