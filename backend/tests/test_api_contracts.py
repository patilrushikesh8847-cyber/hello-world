import asyncio
import os
import unittest

os.environ.setdefault("DATABASE_URL", "postgresql://localhost/northfield_test")
os.environ.setdefault("JWT_SECRET", "test-secret-for-schema-contracts-only-123456789")

from fastapi import HTTPException
from pydantic import ValidationError

from app.main import PaymentCreate, RoomCreate, StudentCreate, app, require_roles, safe_csv_cell


class ApiContractTests(unittest.TestCase):
    def test_protected_api_routes_are_registered(self):
        paths = app.openapi()["paths"]
        self.assertIn("/auth/login", paths)
        self.assertIn("/allocations", paths)
        self.assertIn("/payments", paths)
        self.assertIn("/reports/export", paths)

    def test_new_student_requires_a_long_password(self):
        with self.assertRaises(ValidationError):
            StudentCreate(
                email="student@example.edu",
                full_name="Example Student",
                password="short",
                student_number="S-100",
            )

    def test_student_name_cannot_be_only_whitespace(self):
        with self.assertRaises(ValidationError):
            StudentCreate(
                email="student@example.edu",
                full_name="   ",
                password="a-long-valid-password",
                student_number="S-100",
            )

    def test_room_capacity_cannot_be_zero(self):
        with self.assertRaises(ValidationError):
            RoomCreate(hostel_id="00000000-0000-0000-0000-000000000001", room_number="1", capacity=0)

    def test_payment_amount_must_be_positive(self):
        with self.assertRaises(ValidationError):
            PaymentCreate(
                invoice_id="00000000-0000-0000-0000-000000000001",
                amount=0,
                method="CASH",
            )

    def test_role_guard_rejects_students_on_staff_routes(self):
        staff_only = require_roles("ADMIN", "WARDEN")
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(staff_only(user={"role": "STUDENT"}))
        self.assertEqual(raised.exception.status_code, 403)

    def test_csv_export_neutralizes_spreadsheet_formulas(self):
        self.assertEqual(safe_csv_cell("=1+1"), "'=1+1")
        self.assertEqual(safe_csv_cell("ordinary text"), "ordinary text")


if __name__ == "__main__":
    unittest.main()
