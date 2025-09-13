import { pipeline } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.6.0/dist/transformers.min.js';

    class SemanticSearch {
      constructor(modelName = 'Xenova/all-MiniLM-L6-v2') {
        this.modelName = modelName;
        this.fe = null;
      }

      async init() {
        this.fe = await pipeline('feature-extraction', this.modelName);
      }

      _dot(a, b) {
        let s = 0;
        for (let i = 0; i < a.length; i++) s += a[i] * b[i];
        return s;
      }

      async embed(text) {
          if (!this.fe) throw new Error('Model not initialized. Call init() first.');
          const t = await this.fe(text, { pooling: 'mean', normalize: true });
      
          // Применяем логику как в window.textEmbedderFunction
          let embedding = [...t.data]; // превращаем Float32Array в обычный массив
          embedding = embedding.map(n => Number(n.toFixed(4))); // округляем до 4 знаков
      
          return { text, embed: embedding };
        }



      async search(query, embeddedArray) {
        if (!this.fe) throw new Error('Model not initialized. Call init() first.');
        if (!Array.isArray(embeddedArray) || embeddedArray.length === 0) return [];

        const { embed: qv } = await this.embed(query);

        const scored = embeddedArray.map(({ text, embed }) => ({
          text,
          score: this._dot(qv, embed)
        }));

        scored.sort((a, b) => b.score - a.score);

        return {
          query: { text: query, embed: qv },
          results: scored
        };
      }
    }
window.ebmed = SemanticSearch
