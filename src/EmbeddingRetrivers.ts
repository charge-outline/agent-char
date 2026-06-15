//这个文件的功能就是把输入变成embedding,或者根据输入找到语义相近的输出

import  VectorStore  from "./VectorStore.js";
import { type VectorStoreResult } from "./VectorStore.js";

export default class EmbeddingRetrivers{
    private embeddingModel: string;
    private vectorStore:VectorStore

    constructor(embeddingModel: string) {
        this.embeddingModel = embeddingModel;
        this.vectorStore = new VectorStore();
    }

    async embedQuery(query: string): Promise<number[]>{
        const queryVector= await this.embed(query);
        return queryVector;
    }

    async embedDocuments(documents: string): Promise<number[]>{
        const documentVector= await this.embed(documents);
        this.vectorStore.addItem({
            embedding: documentVector,
            document: documents
        });
        return documentVector;
    }

    private async embed(document: string): Promise<number[]>{
        const response = await fetch(`${process.env.EMBEDDING_BASE_URL}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.EMBEDDING_KEY}`
            },
            body: JSON.stringify({
                "model": this.embeddingModel,
                "input": document
            })
        }
        );
        const data = await response.json();
        console.log(data.data[0].embedding);
        return data.data[0].embedding;
    }
    //retrive是粗排，返回详细的向量数组
    async retrive(query: string, topK: number = 5): Promise<VectorStoreResult[]> { 
        const queryVector = await this.embedQuery(query);
        
        return this.vectorStore.search(queryVector, topK);
    }
}