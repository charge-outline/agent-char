// import type { VectorStores } from "openai/resources";

// import { Embeddings } from "openai/resources"

export interface VectorStoreItem{
    embedding: number[],
    document:string,
}

export interface VectorStoreResult{
    document:string,
    score:number
}

export default class VectorStore{
    private vectorStore: VectorStoreItem[];
    
    constructor() {
        this.vectorStore=[]
    }

    public async addItem(item:VectorStoreItem){
        this.vectorStore.push(item);
    }

    public search(queryEmbedding:number[],topK:number=3) {
        const scored= this.vectorStore.map((item)=>{
            return {
                score: this.consineSim(queryEmbedding, item.embedding),
                document: item.document
            };
        })

        return scored.sort((a,b)=>b.score-a.score).slice(0,topK);
    }

    private consineSim(v1:number[],v2:number[]){
        const dotProduct = v1.reduce((acc, val, i) => acc + val * (v2[i]??0), 0);
        const magnitude1 = Math.sqrt(v1.reduce((acc, val) => acc + val * val, 0));
        const magnitude2 = Math.sqrt(v2.reduce((acc, val) => acc + val * val, 0));
        return dotProduct / (magnitude1 * magnitude2);
    }
}