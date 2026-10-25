
from pathlib import Path
import pandas as pd

file_path = Path("data/skill_builder_data.csv")

if not file_path.exists():
    raise FileNotFoundError(
        f"Dataset not found: {file_path.resolve()}\n"
        "Update file_path to match your actual filename."
    )

print("Loading dataset...")
df = pd.read_csv(
    file_path,
    low_memory=False,
    encoding="cp1252"
)

print("\n1. DATASET SIZE")
print(f"Rows: {len(df):,}")
print(f"Columns: {len(df.columns)}")

print("\n2. REQUIRED COLUMNS")
required = ["user_id", "skill_id", "skill_name", "problem_id", "correct"]
for column in required:
    print(f"{column}: {'Present' if column in df.columns else 'MISSING'}")

print("\n3. MISSING VALUES IN IMPORTANT COLUMNS")
important = [
    "user_id", "skill_id", "skill_name",
    "problem_id", "correct", "order_id"
]
print(df[important].isnull().sum())

print("\n4. CORRECTNESS LABELS")
print(df["correct"].value_counts(dropna=False))

print("\n5. UNIQUE STUDENTS, SKILLS AND QUESTIONS")
print("Students:", df["user_id"].nunique())
print("Skills:", df["skill_id"].nunique())
print("Questions:", df["problem_id"].nunique())

print("\n6. MOST COMMON SKILLS")
print(
    df["skill_name"]
    .value_counts(dropna=False)
    .head(10)
    .to_string()
)

print("\n7. DUPLICATE ROWS")
print(df.duplicated().sum())

print("\n8. FIRST-ATTEMPT LABEL DISTRIBUTION")
print(
    df["correct"]
    .value_counts(normalize=True, dropna=False)
    .mul(100)
    .round(2)
    .astype(str)
    .add("%")
)

print("\n9. INTERACTION ORDER CHECK")

# Check whether order_id is unique and usable for ordering.
print("Unique order IDs:", df["order_id"].nunique())
print("Rows with duplicate order IDs:", df["order_id"].duplicated().sum())

# Check whether each student's order IDs are increasing
# when rows are sorted by order_id.
ordered = df.sort_values("order_id")
per_student = ordered.groupby("user_id")["order_id"]

print(
    "Students with multiple responses:",
    (per_student.size() > 1).sum()
)

print("\n10. ATTEMPT AND OPPORTUNITY FIELDS")
for column in ["attempt_count", "opportunity", "opportunity_original"]:
    if column in df.columns:
        print(f"\n{column}:")
        print(df[column].describe())

print("\n11. TUTOR MODE")
print(df["tutor_mode"].value_counts(dropna=False).head(10))

print("\n12. ROWS WITHOUT A SKILL ID")
print(
    df.loc[df["skill_id"].isna(), ["user_id", "problem_id", "correct"]]
    .head(5)
)

print("\n13. DUPLICATE ORDER ID INVESTIGATION")

# Are order IDs duplicated within the same student?
student_order = df.duplicated(subset=["user_id", "order_id"]).sum()
print("Duplicate (user_id, order_id) pairs:", student_order)

# Inspect examples where an order ID occurs multiple times
duplicate_orders = df[df.duplicated("order_id", keep=False)]
print("\nExample duplicate order IDs:")
print(
    duplicate_orders[
        ["order_id", "user_id", "problem_id", "skill_id", "skill_name", "correct"]
    ].head(12).to_string(index=False)
)

print("\n14. EXTREME ATTEMPT COUNTS")
print(
    df.nlargest(10, "attempt_count")[
        ["user_id", "problem_id", "attempt_count", "correct", "skill_name"]
    ].to_string(index=False)
)

print("\n15. SKILL AND ORIGINAL-PROBLEM CHECK")
print("Original values:")
print(df["original"].value_counts(dropna=False))

print("\nMissing skill ID by original value:")
print(df.groupby("original", dropna=False)["skill_id"].apply(
    lambda x: x.isna().sum()
))


print("\nDataset profiling complete.")
