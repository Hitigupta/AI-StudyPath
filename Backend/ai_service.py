import os
from dotenv import load_dotenv
from google import genai
from google.genai import types
import time

load_dotenv()

API_KEY = os.getenv("GEMINI_API_KEY")
MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")

if not API_KEY:
    raise ValueError("GEMINI_API_KEY is missing from the .env file.")

client = genai.Client(api_key=API_KEY)



def generate_quiz(topic, difficulty="medium", num_questions=5):
    prompt = f"""
    Create exactly {num_questions} multiple-choice questions
    about the topic: {topic}
    Difficulty: {difficulty}

    Return only a JSON array. Each object must contain:
    - question: string
    - concept: a short, specific concept tested by the question
    - options: array of exactly 4 strings
    - answer: one option copied exactly from options
    - explanation: one short sentence explaining the answer

    Requirements:
    - Use clear, technically accurate questions.
    - Avoid duplicate questions.
    - Assign one relevant concept to each question.
    - Use concise, consistent concept names within this quiz.
    - Make sure each question tests the assigned concept.
    - Keep explanations concise.
    """

    start_time = time.perf_counter()
    print("Calling Gemini...", flush=True)

    response = client.models.generate_content(
        model=MODEL_NAME,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            thinking_config=types.ThinkingConfig(
                thinking_level="LOW"
            )
        )
    )

    elapsed = time.perf_counter() - start_time
    print(f"Gemini responded in {elapsed:.2f} seconds", flush=True)

    return response.text
