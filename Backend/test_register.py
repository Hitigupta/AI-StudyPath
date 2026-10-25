
import requests
import getpass

BASE_URL = "http://127.0.0.1:5000"

username = input("Username or email: ").strip()
password = getpass.getpass("Password: ")

with requests.Session() as s:
    # 1. Log in
    login_response = s.post(
        f"{BASE_URL}/login",
        json={
            "username_or_email": username,
            "password": password
        },
        timeout=30
    )

    print("\nLogin:", login_response.status_code)
    print(login_response.text)

    if login_response.status_code != 200:
        raise SystemExit("Login failed.")

    # 2. Generate a new quiz
    quiz_response = s.post(
        f"{BASE_URL}/generate_quiz",
        json={
            "topic": "Dynamic Programming",
            "difficulty": "medium",
            "num_questions": 3
        },
        timeout=180
    )

    print("\nQuiz generation:", quiz_response.status_code)
    print(quiz_response.text)

    if quiz_response.status_code != 201:
        raise SystemExit("Quiz generation failed.")

    quiz = quiz_response.json()
    quiz_id = quiz["quiz_id"]
    questions = quiz["questions"]

    # 3. Enter answers using the displayed option numbers
    answers = {}

    for i, question in enumerate(questions):
        print(f"\nQuestion {i + 1}: {question['question']}")

        for j, option in enumerate(question["options"], start=1):
            print(f"{j}. {option}")

        while True:
            choice = input("Choose option (1-4): ").strip()

            if choice in ("1", "2", "3", "4"):
                answers[str(i)] = question["options"][int(choice) - 1]
                break

            print("Please enter a number from 1 to 4.")

    # 4. Submit the quiz
    submit_response = s.post(
        f"{BASE_URL}/submit_quiz",
        json={
            "quiz_id": quiz_id,
            "answers": answers,
            "time_taken": 60
        },
        timeout=30
    )

    print("\nQuiz submission:", submit_response.status_code)
    print(submit_response.text)

    # 5. Check saved question-level results
    if submit_response.status_code == 200:
        print("\nQuiz submitted successfully!")
        print("Your answers have been graded.")

    
    # 5. Check the stats endpoint using the same logged-in session
    if submit_response.status_code == 200:
        print("\nQuiz submitted successfully!")
        print("Your answers have been graded.")

        stats_response = s.get(
            f"{BASE_URL}/stats",
            timeout=30
        )

        print("\nStats status:", stats_response.status_code)
        print("Stats response:")
        print(stats_response.text)

        weakness_response = s.get(
            f"{BASE_URL}/weaknesses",
            timeout=30
        )

        print("Weakness status:", weakness_response.status_code)
        print(weakness_response.json())

