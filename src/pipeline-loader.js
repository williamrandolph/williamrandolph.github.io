/**
 * Pipeline Data Loader - Imports pre-processed games data from pipeline exports
 * Handles loading JSON data from the offline processing pipeline into IndexedDB
 */

class PipelineLoader {
    constructor(database) {
        this.database = database;
        this.lastLoadDate = null;
        this.loadedGamesCount = 0;
    }

    /**
     * Load games data into IndexedDB
     * @param {Array} games - Array of pipeline game objects
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<object>} - Results summary
     */
    async loadGames(games, onProgress) {
        let successful = 0;
        let failed = 0;
        const errors = [];

        console.log(`⚡ Loading ${games.length} games into database...`);

        for (let i = 0; i < games.length; i++) {
            const game = games[i];
            
            try {
                // Convert pipeline format to database format
                const gameRecord = this.convertPipelineGameToDBFormat(game);
                const locationRecord = this.convertPipelineLocationToDBFormat(game);

                // Save game
                const savedGame = await this.database.saveGame(gameRecord);
                
                // Save location
                const savedLocation = await this.database.saveLocation(locationRecord);
                
                // Link game to location
                await this.database.linkGameToLocation(savedGame.id, savedLocation.id, {
                    source: 'pipeline',
                    matchType: game.match.type,
                    confidence: this.convertConfidenceToNumber(game.match.confidence),
                    score: game.match.score,
                    approved: game.match.approved
                });

                successful++;

                // Progress callback
                if (onProgress) {
                    onProgress({
                        current: i + 1,
                        total: games.length,
                        game: game.name,
                        successful,
                        failed
                    });
                }

            } catch (error) {
                failed++;
                errors.push({
                    game: game.name,
                    error: error.message
                });
                console.warn(`⚠️ Failed to load game "${game.name}":`, error);
            }
        }

        console.log(`✅ Pipeline loading completed: ${successful} successful, ${failed} failed`);

        return {
            successful,
            failed,
            errors
        };
    }

    /**
     * Convert pipeline game format to database game format
     */
    convertPipelineGameToDBFormat(pipelineGame) {
        return {
            id: pipelineGame.id, // Use actual BGG ID from pipeline data
            bggId: pipelineGame.id, // Also store as bggId for clarity
            bggRank: pipelineGame.bggRank, // Preserve BGG ranking
            name: pipelineGame.name,
            yearPublished: pipelineGame.year,
            description: null, // Pipeline doesn't include description in JSON export
            minPlayers: null,
            maxPlayers: null,
            playingTime: null,
            families: [],
            categories: pipelineGame.categories || [],
            mechanics: [],
            rating: {
                average: pipelineGame.rating,
                bayesAverage: null,
                stddev: null,
                numComments: null,
                numWeights: null,
                averageWeight: null,
                votes: pipelineGame.votes
            },
            source: 'pipeline',
            updatedAt: new Date().toISOString()
        };
    }

    /**
     * Convert pipeline location format to database location format
     */
    convertPipelineLocationToDBFormat(pipelineGame) {
        const location = pipelineGame.location;
        return {
            locationString: `${location.city}, ${location.country}`,
            type: 'city',
            geocoded: {
                lat: location.coordinates.lat,
                lng: location.coordinates.lng,
                displayName: `${location.city}, ${location.country}`,
                confidence: this.convertConfidenceToNumber(pipelineGame.match.confidence),
                boundingBox: null,
                address: {
                    city: location.city,
                    country: location.country
                }
            },
            source: 'pipeline',
            population: pipelineGame.population,
            country: location.country,
            city: location.city,
            matchType: pipelineGame.match.type,
            score: pipelineGame.match.score,
            approved: pipelineGame.match.approved
        };
    }

    /**
     * Convert string confidence levels to numbers
     */
    convertConfidenceToNumber(confidenceStr) {
        const confidenceMap = {
            'very_high': 0.95,
            'high': 0.8,
            'medium': 0.6,
            'low': 0.4,
            'very_low': 0.2
        };
        return confidenceMap[confidenceStr] || 0.5;
    }

    /**
     * Get loading statistics
     */
    getStats() {
        return {
            lastLoadDate: this.lastLoadDate,
            loadedGamesCount: this.loadedGamesCount
        };
    }

    /**
     * Load default pipeline data (approved games) from embedded data
     */
    async loadDefaultData(onProgress) {
        return this.loadFromEmbeddedData(PIPELINE_DATA, {
            clearExisting: true,
            onProgress,
            filterApprovedOnly: true
        });
    }


    /**
     * Load pipeline data from embedded JavaScript object
     * @param {object} pipelineData - The embedded pipeline data object
     * @param {object} options - Loading options
     * @returns {Promise<object>} - Loading results
     */
    async loadFromEmbeddedData(pipelineData, options = {}) {
        const {
            clearExisting = true,
            onProgress = null,
            filterApprovedOnly = true
        } = options;

        try {
            console.log('📥 Loading pipeline data from embedded data...');
            
            if (!pipelineData.games || !Array.isArray(pipelineData.games)) {
                throw new Error('Invalid pipeline data format: missing games array');
            }

            console.log('📊 Pipeline metadata:', pipelineData.metadata);

            // Filter games if needed
            let gamesToLoad = pipelineData.games;
            if (filterApprovedOnly) {
                gamesToLoad = pipelineData.games.filter(game => 
                    game.match && game.match.approved === true
                );
                console.log(`🔍 Filtered to ${gamesToLoad.length} approved games from ${pipelineData.games.length} total`);
            }

            // Clear existing data if requested
            if (clearExisting) {
                console.log('🗑️ Clearing existing database...');
                await this.database.clearAllData();
            }

            // Load games into database
            const results = await this.loadGames(gamesToLoad, onProgress);

            this.lastLoadDate = new Date();
            this.loadedGamesCount = results.successful;

            return {
                ...results,
                metadata: pipelineData.metadata,
                filteredCount: gamesToLoad.length,
                totalCount: pipelineData.games.length
            };

        } catch (error) {
            console.error('❌ Pipeline loading failed:', error);
            throw error;
        }
    }
}