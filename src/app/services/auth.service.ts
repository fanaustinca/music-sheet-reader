import { Injectable } from '@angular/core';
import { Router } from '@angular/router';

interface User {
  email: string;
  password: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly USERS_KEY = 'msr_users';
  private readonly SESSION_KEY = 'msr_session';

  constructor(private router: Router) {}

  signup(email: string, password: string): { success: boolean; error?: string } {
    const users: User[] = JSON.parse(localStorage.getItem(this.USERS_KEY) || '[]');
    if (users.find(u => u.email === email)) {
      return { success: false, error: 'Email already registered' };
    }
    users.push({ email, password });
    localStorage.setItem(this.USERS_KEY, JSON.stringify(users));
    localStorage.setItem(this.SESSION_KEY, email);
    return { success: true };
  }

  login(email: string, password: string): { success: boolean; error?: string } {
    const users: User[] = JSON.parse(localStorage.getItem(this.USERS_KEY) || '[]');
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) return { success: false, error: 'Invalid email or password' };
    localStorage.setItem(this.SESSION_KEY, email);
    return { success: true };
  }

  logout() {
    localStorage.removeItem(this.SESSION_KEY);
    this.router.navigate(['/auth/login']);
  }

  isLoggedIn(): boolean {
    return !!localStorage.getItem(this.SESSION_KEY);
  }

  getCurrentUser(): string | null {
    return localStorage.getItem(this.SESSION_KEY);
  }
}
