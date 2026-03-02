import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./components/home/home.component').then(m => m.HomeComponent), canActivate: [authGuard] },
  { path: 'scan', loadComponent: () => import('./components/scanner/scanner.component').then(m => m.ScannerComponent), canActivate: [authGuard] },
  { path: 'auth/login', loadComponent: () => import('./components/auth/login/login.component').then(m => m.LoginComponent) },
  { path: 'auth/signup', loadComponent: () => import('./components/auth/signup/signup.component').then(m => m.SignupComponent) },
  { path: '**', redirectTo: '' }
];
