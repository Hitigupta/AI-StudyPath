
from ai_service import generate_quiz

result = generate_quiz(
    topic="Python functions",
    difficulty="easy",
    num_questions=3
)

print(result)
