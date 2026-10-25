import pandas as pd

def classify_weakness(score):
    if score < 0.30:
        return "Low"
    elif score < 0.50:
        return "Moderate"
    elif score < 0.70:
        return "High"
    else:
        return "Very high"

def build_student_skill_profiles(fit_data, smoothing_strength=5):
    # Average accuracy for each skill
    skill_priors = (
        fit_data.groupby("skill_id")["correct"]
        .mean()
        .rename("skill_prior_accuracy")
    )

    # Summarize each student's performance on each skill
    student_skill = (
        fit_data.groupby(
            ["user_id", "skill_id"], as_index=False
        )
        .agg(
            attempts=("correct", "size"),
            correct_answers=("correct", "sum"),
            raw_accuracy=("correct", "mean")
        )
    )

    # Add the average accuracy for each skill
    student_skill = student_skill.join(
        skill_priors, on="skill_id"
    )

    # Smooth accuracy when a student has few attempts
    student_skill["smoothed_accuracy"] = (
        student_skill["correct_answers"]
        + smoothing_strength
        * student_skill["skill_prior_accuracy"]
    ) / (
        student_skill["attempts"] + smoothing_strength
    )

    # Higher score means greater estimated weakness
    student_skill["weakness_score"] = (
        1 - student_skill["smoothed_accuracy"]
    )

    # Convert numerical scores into categories
    student_skill["weakness_category"] = (
        student_skill["weakness_score"]
        .apply(classify_weakness)
    )

    return student_skill

def get_priority_topics(student_skill, student_id, top_n=3):
    # Keep only profiles with at least 5 attempts
    reliable_profiles = student_skill[
        student_skill["attempts"] >= 5
    ]

    # Find this student's profiles
    student_topics = reliable_profiles[
        reliable_profiles["user_id"] == student_id
    ].copy()

    # Rank topics by weakness score, highest first
    student_topics = student_topics.sort_values(
        "weakness_score",
        ascending=False
    )

    # Return the top N topics
    return student_topics[
        [
            "skill_id",
            "attempts",
            "smoothed_accuracy",
            "weakness_score",
            "weakness_category"
        ]
    ].head(top_n).reset_index(drop=True)

def generate_revision_recommendations(
    student_skill, student_id, top_n=3
):
    topics = get_priority_topics(
        student_skill,
        student_id,
        top_n
    )

    if topics.empty:
        return {
            "message": (
                "Not enough historical data to identify "
                "priority topics. Complete more quizzes first."
            ),
            "recommendations": []
        }

    recommendations = []

    for _, topic in topics.iterrows():
        category = topic["weakness_category"]

        if category == "Very high":
            action = (
                "Review the fundamentals, then solve "
                "easy practice questions."
            )
        elif category == "High":
            action = (
                "Revise the concept and solve targeted "
                "practice questions."
            )
        elif category == "Moderate":
            action = (
                "Review mistakes and complete a short "
                "practice set."
            )
        else:
            action = (
                "Continue practicing and periodically "
                "revise this skill."
            )

        recommendations.append({
            "skill_id": int(topic["skill_id"]),
            "weakness_category": category,
            "attempts": int(topic["attempts"]),
            "estimated_accuracy": round(
                float(topic["smoothed_accuracy"]), 3
            ),
            "recommended_action": action
        })

    return {
        "message": "Revision priorities generated successfully.",
        "recommendations": recommendations
    }

def analyze_live_weaknesses(responses, min_attempts=3):
    """
    Analyze live quiz responses from the StudyPath database.

    Expected columns:
    student_id, topic, concept, is_correct
    """
    import pandas as pd

    if not responses:
        return []

    df = pd.DataFrame(responses)

    required_columns = {
        "student_id", "topic", "concept", "is_correct"
    }

    if not required_columns.issubset(df.columns):
        raise ValueError(
            f"Responses must contain: {required_columns}"
        )

    results = []

    for (topic, concept), group in df.groupby(
        ["topic", "concept"]
    ):
        attempts = len(group)
        correct_answers = int(group["is_correct"].sum())
        accuracy = correct_answers / attempts

        # Do not confidently classify concepts with little data.
        if attempts < min_attempts:
            status = "Insufficient data"
            weakness_score = None
        else:
            weakness_score = 1 - accuracy

            if accuracy < 0.40:
                status = "Weak"
            elif accuracy < 0.70:
                status = "Needs practice"
            else:
                status = "Strong so far"

        results.append({
            "topic": topic,
            "concept": concept,
            "attempts": attempts,
            "correct_answers": correct_answers,
            "accuracy": round(accuracy * 100, 2),
            "weakness_score": (
                round(weakness_score, 3)
                if weakness_score is not None else None
            ),
            "status": status
        })

    # Put concepts needing attention first.
    priority = {
        "Weak": 0,
        "Needs practice": 1,
        "Insufficient data": 2,
        "Strong so far": 3
    }

    results.sort(
        key=lambda item: (
            priority[item["status"]],
            item["accuracy"]
        )
    )

    return results
