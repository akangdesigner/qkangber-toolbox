import Groq from 'groq-sdk'

let client: Groq | null = null

export function getGroqClient(): Groq {
  if (!client) {
    if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY 未設定')
    client = new Groq({ apiKey: process.env.GROQ_API_KEY })
  }
  return client
}

export const GROQ_MODEL = 'llama-3.3-70b-versatile'
