from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import secrets
import smtplib
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from email.message import EmailMessage
from typing import Annotated, Literal

import asyncpg
import jwt
from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from pwdlib import PasswordHash
from fastapi.responses import JSONResponse


class Settings(BaseSettings):
    database_url: str
    jwt_secret: str = Field(min_length=32)
    jwt_expire_minutes: int = 60
    frontend_origins: str = "http://localhost:5173"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from: str | None = None
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
password_hash = PasswordHash.recommended()
bearer = HTTPBearer(auto_error=False)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = await asyncpg.create_pool(settings.database_url, min_size=1, max_size=10)
    async with app.state.pool.acquire() as conn:
        await conn.execute(
            """CREATE TABLE IF NOT EXISTS revoked_tokens (
                   jti TEXT PRIMARY KEY,
                   expires_at TIMESTAMPTZ NOT NULL
               )"""
        )
    yield
    await app.state.pool.close()


app = FastAPI(title="Northfield Hostel API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.frontend_origins.split(",") if origin.strip()],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.exception_handler(asyncpg.UniqueViolationError)
async def unique_conflict(request: Request, exc: asyncpg.UniqueViolationError):
    return JSONResponse(status_code=409, content={"detail": "A record with these values already exists"})


@app.exception_handler(asyncpg.ForeignKeyViolationError)
async def invalid_reference(request: Request, exc: asyncpg.ForeignKeyViolationError):
    return JSONResponse(status_code=409, content={"detail": "A referenced record is missing or still in use"})


class LoginBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class ResetRequest(BaseModel):
    email: EmailStr


class ResetBody(BaseModel):
    token: str = Field(min_length=32, max_length=256)
    password: str = Field(min_length=12, max_length=256)


class StudentCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=12, max_length=256)
    student_number: str = Field(min_length=1, max_length=40)
    phone: str = Field(default="", max_length=30)
    course: str = Field(default="", max_length=120)
    guardian_name: str = Field(default="", max_length=120)
    guardian_phone: str = Field(default="", max_length=30)

    @field_validator("full_name", "student_number")
    @classmethod
    def required_values_are_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be blank")
        return value


class WardenCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=12, max_length=256)

    @field_validator("full_name")
    @classmethod
    def name_is_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name cannot be blank")
        return value


class StudentUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    course: str | None = Field(default=None, max_length=120)
    guardian_name: str | None = Field(default=None, max_length=120)
    guardian_phone: str | None = Field(default=None, max_length=30)
    status: Literal["ACTIVE", "INACTIVE"] | None = None


class HostelCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    address: str = Field(default="", max_length=300)
    warden_id: uuid.UUID | None = None

    @field_validator("name")
    @classmethod
    def hostel_name_is_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Hostel name cannot be blank")
        return value


class RoomCreate(BaseModel):
    hostel_id: uuid.UUID
    room_number: str = Field(min_length=1, max_length=30)
    floor: int = Field(default=0, ge=0, le=100)
    capacity: int = Field(ge=1, le=50)
    monthly_fee: Decimal = Field(default=Decimal("0"), ge=0, le=1_000_000)

    @field_validator("room_number")
    @classmethod
    def room_number_is_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Room number cannot be blank")
        return value


class AllocationCreate(BaseModel):
    student_id: uuid.UUID
    room_id: uuid.UUID


class InvoiceCreate(BaseModel):
    student_id: uuid.UUID
    description: str = Field(min_length=2, max_length=200)
    amount: Decimal = Field(gt=0, le=10_000_000)
    due_date: date

    @field_validator("description")
    @classmethod
    def invoice_description_is_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Description cannot be blank")
        return value


class PaymentCreate(BaseModel):
    invoice_id: uuid.UUID
    amount: Decimal = Field(gt=0, le=10_000_000)
    method: Literal["CASH", "BANK_TRANSFER", "CARD", "OTHER"]
    reference: str = Field(default="", max_length=120)


class ComplaintCreate(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    description: str = Field(min_length=10, max_length=3000)
    category: Literal["MAINTENANCE", "CLEANING", "ELECTRICAL", "PLUMBING", "OTHER"]

    @field_validator("title", "description")
    @classmethod
    def complaint_text_is_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be blank")
        return value


class ComplaintUpdate(BaseModel):
    status: Literal["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]


class NoticeCreate(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    body: str = Field(min_length=5, max_length=5000)
    audience: Literal["ALL", "STUDENTS", "WARDENS"] = "ALL"

    @field_validator("title", "body")
    @classmethod
    def notice_text_is_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be blank")
        return value


async def current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
):
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to continue")
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=["HS256"])
        user_id = uuid.UUID(payload["sub"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired session") from None
    user = await request.app.state.pool.fetchrow(
        "SELECT id, email, full_name, role FROM users WHERE id = $1", user_id
    )
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account no longer exists")
    jti = payload.get("jti")
    if not jti or await request.app.state.pool.fetchval("SELECT 1 FROM revoked_tokens WHERE jti=$1", jti):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session is invalid or has been signed out")
    return {**dict(user), "jti": jti, "exp": payload["exp"]}


def require_roles(*roles: str):
    async def dependency(user=Depends(current_user)):
        if user["role"] not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not have permission to do this")
        return user
    return dependency


Staff = Depends(require_roles("ADMIN", "WARDEN"))
Admin = Depends(require_roles("ADMIN"))


async def student_id_for(pool, user):
    row = await pool.fetchrow("SELECT id FROM students WHERE user_id = $1", user["id"])
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Student profile not found")
    return row["id"]


async def check_warden_hostel(pool, user, hostel_id):
    if user["role"] == "WARDEN":
        assigned = await pool.fetchval("SELECT 1 FROM hostels WHERE id=$1 AND warden_id=$2", hostel_id, user["id"])
        if not assigned:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This hostel is not assigned to you")


def as_dict(row):
    return dict(row) if row is not None else None


def safe_csv_cell(value):
    if isinstance(value, str) and value.lstrip(" \t\r\n").startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/auth/login")
async def login(body: LoginBody, request: Request):
    user = await request.app.state.pool.fetchrow(
        "SELECT * FROM users WHERE lower(email)=lower($1)", body.email
    )
    if user is None or not password_hash.verify(body.password, user["password_hash"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Email or password is incorrect")
    token = jwt.encode(
        {"sub": str(user["id"]), "jti": secrets.token_urlsafe(18),
         "exp": datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)},
        settings.jwt_secret,
        algorithm="HS256",
    )
    return {"access_token": token, "token_type": "bearer", "user": {
        "id": str(user["id"]), "email": user["email"], "full_name": user["full_name"], "role": user["role"]
    }}


@app.get("/auth/me")
async def me(user=Depends(current_user)):
    return {"id": str(user["id"]), "email": user["email"], "full_name": user["full_name"], "role": user["role"]}


@app.post("/auth/logout", status_code=204)
async def logout(request: Request, user=Depends(current_user)):
    await request.app.state.pool.execute(
        "INSERT INTO revoked_tokens(jti,expires_at) VALUES($1,to_timestamp($2)) ON CONFLICT DO NOTHING",
        user["jti"], user["exp"],
    )
    return None


def send_reset_email(email: str, token: str):
    if not all((settings.smtp_host, settings.smtp_from)):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Password reset email is not configured. Contact your administrator.")
    message = EmailMessage()
    message["Subject"] = "Reset your Northfield password"
    message["From"] = settings.smtp_from
    message["To"] = email
    message.set_content(f"Use this one-time password reset token within 30 minutes:\n\n{token}\n\nIf you did not request this, ignore this email.")
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
        smtp.starttls()
        if settings.smtp_user and settings.smtp_password:
            smtp.login(settings.smtp_user, settings.smtp_password)
        smtp.send_message(message)


@app.post("/auth/password-reset")
async def request_password_reset(body: ResetRequest, request: Request):
    pool = request.app.state.pool
    if not all((settings.smtp_host, settings.smtp_from)):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Password reset email is not configured. Contact your administrator.")
    user = await pool.fetchrow("SELECT id,email FROM users WHERE lower(email)=lower($1)", body.email)
    if user is None:
        return {"message": "If the account exists, reset instructions will be sent."}
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    await pool.execute(
        "INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 minutes')",
        user["id"], token_hash,
    )
    try:
        await asyncio.to_thread(send_reset_email, user["email"], token)
    except Exception as exc:
        await pool.execute("DELETE FROM password_resets WHERE token_hash=$1", token_hash)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Password reset email could not be delivered. Contact your administrator.") from exc
    return {"message": "If the account exists, reset instructions will be sent."}


@app.post("/auth/password-reset/confirm")
async def confirm_password_reset(body: ResetBody, request: Request):
    token_hash = hashlib.sha256(body.token.encode()).hexdigest()
    async with request.app.state.pool.acquire() as conn:
        async with conn.transaction():
            reset = await conn.fetchrow(
                "SELECT id,user_id FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE",
                token_hash,
            )
            if reset is None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Reset token is invalid or expired")
            await conn.execute("UPDATE users SET password_hash=$1 WHERE id=$2", password_hash.hash(body.password), reset["user_id"])
            await conn.execute("UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", reset["user_id"])
    return {"message": "Password updated. Sign in with your new password."}


@app.get("/students")
async def list_students(request: Request, user=Staff, search: str = Query(default="", max_length=120)):
    pool = request.app.state.pool
    rows = await pool.fetch(
        """SELECT s.id,s.student_number,s.phone,s.course,s.guardian_name,s.guardian_phone,s.status,
                  u.full_name,u.email,a.id AS allocation_id,r.room_number,h.name AS hostel_name
           FROM students s JOIN users u ON u.id=s.user_id
           LEFT JOIN allocations a ON a.student_id=s.id AND a.check_out IS NULL
           LEFT JOIN rooms r ON r.id=a.room_id LEFT JOIN hostels h ON h.id=r.hostel_id
           WHERE ($1='' OR u.full_name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%' OR s.student_number ILIKE '%'||$1||'%')
             AND ($2::text <> 'WARDEN' OR EXISTS (SELECT 1 FROM allocations x JOIN rooms rr ON rr.id=x.room_id
                   JOIN hostels hh ON hh.id=rr.hostel_id WHERE x.student_id=s.id AND x.check_out IS NULL AND hh.warden_id=$3))
           ORDER BY u.full_name LIMIT 500""",
        search, user["role"], user["id"],
    )
    return [as_dict(row) for row in rows]


@app.post("/students", status_code=201)
async def create_student(body: StudentCreate, request: Request, user=Admin):
    pool = request.app.state.pool
    async with pool.acquire() as conn:
        async with conn.transaction():
            account = await conn.fetchrow(
                "INSERT INTO users(email,full_name,role,password_hash) VALUES($1,$2,'STUDENT',$3) RETURNING id",
                body.email, body.full_name.strip(), password_hash.hash(body.password),
            )
            row = await conn.fetchrow(
                """INSERT INTO students(user_id,student_number,phone,course,guardian_name,guardian_phone)
                   VALUES($1,$2,$3,$4,$5,$6) RETURNING id""",
                account["id"], body.student_number.strip(), body.phone.strip(), body.course.strip(),
                body.guardian_name.strip(), body.guardian_phone.strip(),
            )
    return {"id": str(row["id"]), "student_number": body.student_number}


@app.patch("/students/{student_id}")
async def update_student(student_id: uuid.UUID, body: StudentUpdate, request: Request, user=Staff):
    data = body.model_dump(exclude_unset=True, exclude_none=True)
    async with request.app.state.pool.acquire() as conn:
        async with conn.transaction():
            student = await conn.fetchrow("SELECT user_id FROM students WHERE id=$1", student_id)
            if student is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Student not found")
            if user["role"] == "WARDEN":
                assigned = await conn.fetchval(
                    """SELECT 1 FROM allocations a JOIN rooms r ON r.id=a.room_id JOIN hostels h ON h.id=r.hostel_id
                       WHERE a.student_id=$1 AND a.check_out IS NULL AND h.warden_id=$2""", student_id, user["id"])
                if not assigned:
                    raise HTTPException(status.HTTP_403_FORBIDDEN, "Student is not in your assigned hostel")
            if "full_name" in data:
                await conn.execute("UPDATE users SET full_name=$2 WHERE id=$1", student["user_id"], data["full_name"].strip())
            student_fields = {k: data[k] for k in ("phone", "course", "guardian_name", "guardian_phone") if k in data}
            if student_fields:
                sets = [f"{key}=${i + 2}" for i, key in enumerate(student_fields)]
                values = [value.strip() for value in student_fields.values()]
                await conn.execute(f"UPDATE students SET {', '.join(sets)} WHERE id=$1", student_id, *values)
            if "status" in data:
                await conn.execute("UPDATE students SET status=$2 WHERE id=$1", student_id, data["status"])
    return {"message": "Student updated"}


@app.get("/wardens")
async def list_wardens(request: Request, user=Admin):
    rows = await request.app.state.pool.fetch(
        "SELECT id,email,full_name FROM users WHERE role='WARDEN' ORDER BY full_name"
    )
    return [as_dict(row) for row in rows]


@app.post("/wardens", status_code=201)
async def create_warden(body: WardenCreate, request: Request, user=Admin):
    row = await request.app.state.pool.fetchrow(
        "INSERT INTO users(email,full_name,role,password_hash) VALUES($1,$2,'WARDEN',$3) RETURNING id",
        body.email, body.full_name.strip(), password_hash.hash(body.password),
    )
    return {"id": str(row["id"])}


@app.get("/hostels")
async def list_hostels(request: Request, user=Staff):
    rows = await request.app.state.pool.fetch(
        """SELECT h.id,h.name,h.address,h.warden_id,u.full_name AS warden_name,
                  (SELECT count(*)::int FROM rooms rr WHERE rr.hostel_id=h.id) AS rooms,
                  (SELECT coalesce(sum(rr.capacity),0)::int FROM rooms rr WHERE rr.hostel_id=h.id) AS capacity,
                  count(DISTINCT a.student_id)::int AS occupied
           FROM hostels h LEFT JOIN users u ON u.id=h.warden_id LEFT JOIN rooms r ON r.hostel_id=h.id
           LEFT JOIN allocations a ON a.room_id=r.id AND a.check_out IS NULL
           WHERE ($1::text <> 'WARDEN' OR h.warden_id=$2)
           GROUP BY h.id,u.full_name ORDER BY h.name""", user["role"], user["id"])
    return [as_dict(r) for r in rows]


@app.post("/hostels", status_code=201)
async def create_hostel(body: HostelCreate, request: Request, user=Admin):
    if body.warden_id and not await request.app.state.pool.fetchval("SELECT 1 FROM users WHERE id=$1 AND role='WARDEN'", body.warden_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Selected account is not a warden")
    row = await request.app.state.pool.fetchrow(
        "INSERT INTO hostels(name,address,warden_id) VALUES($1,$2,$3) RETURNING id",
        body.name.strip(), body.address.strip(), body.warden_id)
    return {"id": str(row["id"])}


@app.get("/rooms")
async def list_rooms(request: Request, user=Staff):
    rows = await request.app.state.pool.fetch(
        """SELECT r.id,r.hostel_id,r.room_number,r.floor,r.capacity,r.monthly_fee,h.name AS hostel_name,
                  count(a.id)::int AS occupied
           FROM rooms r JOIN hostels h ON h.id=r.hostel_id
           LEFT JOIN allocations a ON a.room_id=r.id AND a.check_out IS NULL
           WHERE ($1::text <> 'WARDEN' OR h.warden_id=$2)
           GROUP BY r.id,h.name ORDER BY h.name,r.floor,r.room_number""", user["role"], user["id"])
    return [as_dict(r) for r in rows]


@app.post("/rooms", status_code=201)
async def create_room(body: RoomCreate, request: Request, user=Staff):
    await check_warden_hostel(request.app.state.pool, user, body.hostel_id)
    row = await request.app.state.pool.fetchrow(
        "INSERT INTO rooms(hostel_id,room_number,floor,capacity,monthly_fee) VALUES($1,$2,$3,$4,$5) RETURNING id",
        body.hostel_id, body.room_number.strip(), body.floor, body.capacity, body.monthly_fee)
    return {"id": str(row["id"])}


@app.post("/allocations", status_code=201)
async def allocate_room(body: AllocationCreate, request: Request, user=Staff):
    async with request.app.state.pool.acquire() as conn:
        async with conn.transaction():
            room = await conn.fetchrow("SELECT * FROM rooms WHERE id=$1 FOR UPDATE", body.room_id)
            if room is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Room not found")
            await check_warden_hostel(conn, user, room["hostel_id"])
            active = await conn.fetchval("SELECT count(*) FROM allocations WHERE room_id=$1 AND check_out IS NULL", body.room_id)
            if active >= room["capacity"]:
                raise HTTPException(status.HTTP_409_CONFLICT, "Room is at capacity")
            student = await conn.fetchrow("SELECT id FROM students WHERE id=$1 AND status='ACTIVE' FOR UPDATE", body.student_id)
            if student is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Active student not found")
            if await conn.fetchval("SELECT 1 FROM allocations WHERE student_id=$1 AND check_out IS NULL", body.student_id):
                raise HTTPException(status.HTTP_409_CONFLICT, "Student already has an active room allocation. Check them out before transferring.")
            row = await conn.fetchrow(
                "INSERT INTO allocations(student_id,room_id) VALUES($1,$2) RETURNING id",
                body.student_id, body.room_id)
    return {"id": str(row["id"])}


@app.post("/allocations/{allocation_id}/checkout")
async def checkout(allocation_id: uuid.UUID, request: Request, user=Staff):
    async with request.app.state.pool.acquire() as conn:
        async with conn.transaction():
            allocation = await conn.fetchrow(
                "SELECT a.id,h.warden_id FROM allocations a JOIN rooms r ON r.id=a.room_id JOIN hostels h ON h.id=r.hostel_id WHERE a.id=$1 AND a.check_out IS NULL FOR UPDATE OF a",
                allocation_id)
            if allocation is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Active allocation not found")
            if user["role"] == "WARDEN" and allocation["warden_id"] != user["id"]:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Allocation is outside your assigned hostel")
            await conn.execute("UPDATE allocations SET check_out=CURRENT_DATE WHERE id=$1", allocation_id)
    return {"message": "Student checked out"}


@app.get("/invoices")
async def list_invoices(request: Request, user=Depends(current_user)):
    pool = request.app.state.pool
    if user["role"] == "STUDENT":
        sid = await student_id_for(pool, user)
        rows = await pool.fetch("SELECT * FROM invoice_balances WHERE student_id=$1 ORDER BY due_date DESC", sid)
    else:
        rows = await pool.fetch(
            """SELECT b.*,u.full_name AS student_name,s.student_number FROM invoice_balances b
               JOIN students s ON s.id=b.student_id JOIN users u ON u.id=s.user_id
               WHERE ($1::text <> 'WARDEN' OR EXISTS(SELECT 1 FROM allocations a JOIN rooms r ON r.id=a.room_id
                 JOIN hostels h ON h.id=r.hostel_id WHERE a.student_id=b.student_id AND a.check_out IS NULL AND h.warden_id=$2))
               ORDER BY b.due_date DESC LIMIT 1000""", user["role"], user["id"])
    return [as_dict(r) for r in rows]


@app.post("/invoices", status_code=201)
async def create_invoice(body: InvoiceCreate, request: Request, user=Staff):
    if user["role"] == "WARDEN":
        sid = await request.app.state.pool.fetchval(
            """SELECT s.id FROM students s JOIN allocations a ON a.student_id=s.id AND a.check_out IS NULL
               JOIN rooms r ON r.id=a.room_id JOIN hostels h ON h.id=r.hostel_id WHERE s.id=$1 AND h.warden_id=$2""",
            body.student_id, user["id"])
        if not sid:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Student is outside your assigned hostel")
    row = await request.app.state.pool.fetchrow(
        "INSERT INTO invoices(student_id,description,amount,due_date) VALUES($1,$2,$3,$4) RETURNING id",
        body.student_id, body.description.strip(), body.amount, body.due_date)
    return {"id": str(row["id"])}


@app.post("/payments", status_code=201)
async def record_payment(body: PaymentCreate, request: Request, user=Staff):
    pool = request.app.state.pool
    async with pool.acquire() as conn:
        async with conn.transaction():
            invoice = await conn.fetchrow("SELECT id,student_id FROM invoices WHERE id=$1 FOR UPDATE", body.invoice_id)
            if invoice is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found")
            balance = await conn.fetchval(
                """SELECT i.amount-coalesce(sum(p.amount),0) FROM invoices i
                   LEFT JOIN payments p ON p.invoice_id=i.id WHERE i.id=$1 GROUP BY i.id""",
                body.invoice_id,
            )
            if user["role"] == "WARDEN":
                assigned = await conn.fetchval(
                    """SELECT 1 FROM allocations a JOIN rooms r ON r.id=a.room_id JOIN hostels h ON h.id=r.hostel_id
                       WHERE a.student_id=$1 AND a.check_out IS NULL AND h.warden_id=$2""",
                    invoice["student_id"], user["id"])
                if not assigned:
                    raise HTTPException(status.HTTP_403_FORBIDDEN, "Student is outside your assigned hostel")
            if body.amount > balance:
                raise HTTPException(status.HTTP_409_CONFLICT, "Payment exceeds the outstanding balance")
            row = await conn.fetchrow(
                "INSERT INTO payments(invoice_id,amount,method,reference,received_by) VALUES($1,$2,$3,$4,$5) RETURNING id",
                body.invoice_id, body.amount, body.method, body.reference.strip(), user["id"])
    return {"id": str(row["id"]), "message": "Payment recorded"}


@app.get("/payments")
async def list_payments(request: Request, user=Depends(current_user)):
    rows = await request.app.state.pool.fetch(
        """SELECT p.id,p.invoice_id,p.amount,p.method,p.reference,p.paid_at,i.description,
                  u.full_name AS student_name,s.student_number
           FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN students s ON s.id=i.student_id
           JOIN users u ON u.id=s.user_id
           WHERE ($1::text <> 'STUDENT' OR s.user_id=$2)
             AND ($1::text <> 'WARDEN' OR EXISTS(SELECT 1 FROM allocations a JOIN rooms r ON r.id=a.room_id
               JOIN hostels h ON h.id=r.hostel_id WHERE a.student_id=s.id AND a.check_out IS NULL AND h.warden_id=$2))
           ORDER BY p.paid_at DESC LIMIT 1000""", user["role"], user["id"])
    return [as_dict(r) for r in rows]


@app.get("/complaints")
async def list_complaints(request: Request, user=Depends(current_user)):
    rows = await request.app.state.pool.fetch(
        """SELECT c.id,c.student_id,c.title,c.description,c.category,c.status,c.created_at,c.updated_at,
                  u.full_name AS student_name,s.student_number,r.room_number,h.name AS hostel_name
           FROM complaints c JOIN students s ON s.id=c.student_id JOIN users u ON u.id=s.user_id
           LEFT JOIN allocations a ON a.student_id=s.id AND a.check_out IS NULL
           LEFT JOIN rooms r ON r.id=a.room_id LEFT JOIN hostels h ON h.id=r.hostel_id
           WHERE ($1::text <> 'STUDENT' OR s.user_id=$2)
             AND ($1::text <> 'WARDEN' OR h.warden_id=$2)
           ORDER BY c.created_at DESC LIMIT 1000""", user["role"], user["id"])
    return [as_dict(r) for r in rows]


@app.post("/complaints", status_code=201)
async def create_complaint(body: ComplaintCreate, request: Request, user=Depends(current_user)):
    if user["role"] != "STUDENT":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only students can submit complaints")
    sid = await student_id_for(request.app.state.pool, user)
    row = await request.app.state.pool.fetchrow(
        "INSERT INTO complaints(student_id,title,description,category) VALUES($1,$2,$3,$4) RETURNING id",
        sid, body.title.strip(), body.description.strip(), body.category)
    return {"id": str(row["id"]), "message": "Complaint submitted"}


@app.patch("/complaints/{complaint_id}")
async def update_complaint(complaint_id: uuid.UUID, body: ComplaintUpdate, request: Request, user=Staff):
    async with request.app.state.pool.acquire() as conn:
        async with conn.transaction():
            complaint = await conn.fetchrow("SELECT student_id FROM complaints WHERE id=$1 FOR UPDATE", complaint_id)
            if complaint is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Complaint not found")
            if user["role"] == "WARDEN":
                assigned = await conn.fetchval(
                    """SELECT 1 FROM allocations a JOIN rooms r ON r.id=a.room_id JOIN hostels h ON h.id=r.hostel_id
                       WHERE a.student_id=$1 AND a.check_out IS NULL AND h.warden_id=$2""",
                    complaint["student_id"], user["id"])
                if not assigned:
                    raise HTTPException(status.HTTP_403_FORBIDDEN, "Complaint is outside your assigned hostel")
            await conn.execute("UPDATE complaints SET status=$2,updated_at=now() WHERE id=$1", complaint_id, body.status)
    return {"message": "Complaint status updated"}


@app.get("/notices")
async def list_notices(request: Request, user=Depends(current_user)):
    audience = "STUDENTS" if user["role"] == "STUDENT" else "WARDENS" if user["role"] == "WARDEN" else "ALL"
    rows = await request.app.state.pool.fetch(
        """SELECT n.id,n.title,n.body,n.audience,n.published_at,u.full_name AS author
           FROM notices n JOIN users u ON u.id=n.published_by
           WHERE n.audience='ALL' OR n.audience=$1 OR $2='ADMIN'
           ORDER BY n.published_at DESC LIMIT 100""", audience, user["role"])
    return [as_dict(r) for r in rows]


@app.post("/notices", status_code=201)
async def create_notice(body: NoticeCreate, request: Request, user=Staff):
    row = await request.app.state.pool.fetchrow(
        "INSERT INTO notices(title,body,audience,published_by) VALUES($1,$2,$3,$4) RETURNING id",
        body.title.strip(), body.body.strip(), body.audience, user["id"])
    return {"id": str(row["id"])}


@app.get("/reports/summary")
async def summary(request: Request, user=Depends(current_user)):
    pool = request.app.state.pool
    if user["role"] == "STUDENT":
        sid = await student_id_for(pool, user)
        rows = await pool.fetchrow(
            """SELECT (SELECT count(*) FROM invoices WHERE student_id=$1)::int AS invoices,
                      (SELECT coalesce(sum(balance),0) FROM invoice_balances WHERE student_id=$1) AS outstanding,
                      (SELECT count(*) FROM complaints WHERE student_id=$1 AND status NOT IN ('RESOLVED','CLOSED'))::int AS open_complaints""", sid)
        room = await pool.fetchrow(
            """SELECT h.name AS hostel_name,r.room_number,a.check_in FROM allocations a
               JOIN rooms r ON r.id=a.room_id JOIN hostels h ON h.id=r.hostel_id
               WHERE a.student_id=$1 AND a.check_out IS NULL""", sid)
        return {"invoices": as_dict(rows), "room": as_dict(room)}
    rows = await pool.fetchrow(
        """SELECT (SELECT count(*) FROM students WHERE status='ACTIVE'
                    AND ($1::text <> 'WARDEN' OR EXISTS(SELECT 1 FROM allocations a JOIN rooms r ON r.id=a.room_id
                      JOIN hostels h ON h.id=r.hostel_id WHERE a.student_id=students.id AND a.check_out IS NULL AND h.warden_id=$2)))::int AS students,
                  (SELECT count(*) FROM rooms r JOIN hostels h ON h.id=r.hostel_id
                    WHERE $1::text <> 'WARDEN' OR h.warden_id=$2)::int AS rooms,
                  (SELECT coalesce(sum(r.capacity),0) FROM rooms r JOIN hostels h ON h.id=r.hostel_id
                    WHERE $1::text <> 'WARDEN' OR h.warden_id=$2)::int AS beds,
                  (SELECT count(*) FROM allocations a JOIN rooms r ON r.id=a.room_id JOIN hostels h ON h.id=r.hostel_id
                    WHERE a.check_out IS NULL AND ($1::text <> 'WARDEN' OR h.warden_id=$2))::int AS occupied,
                  (SELECT count(*) FROM complaints c WHERE c.status NOT IN ('RESOLVED','CLOSED')
                    AND ($1::text <> 'WARDEN' OR EXISTS(SELECT 1 FROM allocations a JOIN rooms r ON r.id=a.room_id
                      JOIN hostels h ON h.id=r.hostel_id WHERE a.student_id=c.student_id AND a.check_out IS NULL AND h.warden_id=$2)))::int AS open_complaints,
                  (SELECT coalesce(sum(balance),0) FROM invoice_balances b WHERE balance>0
                    AND ($1::text <> 'WARDEN' OR EXISTS(SELECT 1 FROM allocations a JOIN rooms r ON r.id=a.room_id
                      JOIN hostels h ON h.id=r.hostel_id WHERE a.student_id=b.student_id AND a.check_out IS NULL AND h.warden_id=$2))) AS outstanding""",
        user["role"], user["id"])
    return as_dict(rows)


@app.get("/reports/export")
async def export_report(
    request: Request,
    report: Literal["students", "rooms", "invoices", "payments", "complaints"] = "students",
    search: str = Query(default="", max_length=120),
    status_filter: str = Query(default="", max_length=40),
    user=Staff,
):
    pool = request.app.state.pool
    queries = {
        "students": """SELECT s.student_number,u.full_name,u.email,s.phone,s.course,s.status,h.name AS hostel,r.room_number
                       FROM students s JOIN users u ON u.id=s.user_id
                       LEFT JOIN allocations a ON a.student_id=s.id AND a.check_out IS NULL
                       LEFT JOIN rooms r ON r.id=a.room_id LEFT JOIN hostels h ON h.id=r.hostel_id
                       WHERE ($1::text <> 'WARDEN' OR h.warden_id=$2) ORDER BY u.full_name""",
        "rooms": """SELECT h.name AS hostel,r.room_number,r.floor,r.capacity,count(a.id)::int AS occupied,
                            r.monthly_fee FROM rooms r JOIN hostels h ON h.id=r.hostel_id
                    LEFT JOIN allocations a ON a.room_id=r.id AND a.check_out IS NULL
                    WHERE ($1::text <> 'WARDEN' OR h.warden_id=$2) GROUP BY h.name,r.id ORDER BY h.name,r.room_number""",
        "invoices": """SELECT u.full_name,s.student_number,b.description,b.amount,b.paid,b.balance,b.due_date
                       FROM invoice_balances b JOIN students s ON s.id=b.student_id JOIN users u ON u.id=s.user_id
                       WHERE ($1::text <> 'WARDEN' OR EXISTS(SELECT 1 FROM allocations a JOIN rooms r ON r.id=a.room_id
                       JOIN hostels h ON h.id=r.hostel_id WHERE a.student_id=s.id AND a.check_out IS NULL AND h.warden_id=$2))""",
        "payments": """SELECT u.full_name,s.student_number,p.amount,p.method,p.reference,p.paid_at
                       FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN students s ON s.id=i.student_id
                       JOIN users u ON u.id=s.user_id WHERE ($1::text <> 'WARDEN' OR EXISTS(SELECT 1 FROM allocations a
                       JOIN rooms r ON r.id=a.room_id JOIN hostels h ON h.id=r.hostel_id
                       WHERE a.student_id=s.id AND a.check_out IS NULL AND h.warden_id=$2)) ORDER BY p.paid_at DESC""",
        "complaints": """SELECT u.full_name,s.student_number,c.title,c.category,c.status,c.created_at,c.updated_at
                         FROM complaints c JOIN students s ON s.id=c.student_id JOIN users u ON u.id=s.user_id
                         LEFT JOIN allocations a ON a.student_id=s.id AND a.check_out IS NULL
                         LEFT JOIN rooms r ON r.id=a.room_id LEFT JOIN hostels h ON h.id=r.hostel_id
                         WHERE ($1::text <> 'WARDEN' OR h.warden_id=$2) ORDER BY c.created_at DESC""",
    }
    records = list(await pool.fetch(queries[report], user["role"], user["id"]))
    if search:
        term = search.casefold()
        records = [
            row for row in records
            if any(term in str(value).casefold() for value in row.values() if value is not None)
        ]
    if status_filter and report in ("students", "complaints"):
        records = [row for row in records if row["status"] == status_filter]
    output = io.StringIO()
    writer = csv.writer(output)
    if records:
        writer.writerow(records[0].keys())
        for row in records:
            values = [
                value.isoformat() if isinstance(value, (date, datetime)) else value
                for value in row.values()
            ]
            writer.writerow([safe_csv_cell(value) for value in values])
    return {"filename": f"northfield-{report}.csv", "csv": output.getvalue()}


@app.get("/reports/receipt/{payment_id}")
async def receipt(payment_id: uuid.UUID, request: Request, user=Depends(current_user)):
    row = await request.app.state.pool.fetchrow(
        """SELECT p.id,p.amount,p.method,p.reference,p.paid_at,i.description,i.student_id,
                  s.student_number,u.full_name FROM payments p JOIN invoices i ON i.id=p.invoice_id
                  JOIN students s ON s.id=i.student_id JOIN users u ON u.id=s.user_id WHERE p.id=$1""", payment_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Payment not found")
    if user["role"] == "STUDENT" and (await student_id_for(request.app.state.pool, user)) != row["student_id"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This receipt is not yours")
    if user["role"] == "WARDEN":
        assigned = await request.app.state.pool.fetchval(
            """SELECT 1 FROM allocations a JOIN rooms r ON r.id=a.room_id JOIN hostels h ON h.id=r.hostel_id
               WHERE a.student_id=$1 AND h.warden_id=$2""", row["student_id"], user["id"])
        if not assigned:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Receipt is outside your assigned hostel")
    return as_dict(row)
