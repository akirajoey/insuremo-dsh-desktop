#define UNICODE
#define _UNICODE

#include <windows.h>
#include <sddl.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <atomic>

#pragma comment(lib, "Advapi32.lib")

namespace {

constexpr char kControlPrefix[] = "__DSH_CONTROL__";
constexpr DWORD kShutdownGraceMs = 5000;

std::wstring argument(int argc, wchar_t** argv, const wchar_t* name) {
  const std::wstring prefix = std::wstring(name) + L"=";
  for (int i = 1; i < argc; ++i) {
    const std::wstring current(argv[i]);
    if (current.rfind(prefix, 0) == 0) return current.substr(prefix.size());
  }
  return L"";
}

// Matches CommandLineToArgvW backslash/quote rules, including trailing slashes.
std::wstring quoteArgument(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
    } else if (character == L'"') {
      result.append(backslashes * 2 + 1, L'\\');
      result += L'"';
      backslashes = 0;
    } else {
      result.append(backslashes, L'\\');
      result += character;
      backslashes = 0;
    }
  }
  result.append(backslashes * 2, L'\\');
  result += L'"';
  return result;
}

bool currentUserSecurity(SECURITY_ATTRIBUTES& attributes, PSECURITY_DESCRIPTOR& descriptor) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD bytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
  std::vector<BYTE> buffer(bytes);
  if (!GetTokenInformation(token, TokenUser, buffer.data(), bytes, &bytes)) {
    CloseHandle(token);
    return false;
  }
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<PSID>(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid), &sid)) {
    CloseHandle(token);
    return false;
  }
  const std::wstring sddl = L"D:P(A;;GA;;;" + std::wstring(sid) + L")";
  LocalFree(sid);
  CloseHandle(token);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
      sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return false;
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = descriptor;
  attributes.bInheritHandle = FALSE;
  return true;
}

bool writePipe(HANDLE pipe, const std::string& value, std::mutex& lock) {
  std::lock_guard<std::mutex> guard(lock);
  DWORD written = 0;
  return WriteFile(pipe, value.data(), static_cast<DWORD>(value.size()), &written, nullptr) &&
         written == value.size();
}

bool readLine(HANDLE pipe, std::string& line) {
  line.clear();
  char character = 0;
  DWORD read = 0;
  while (ReadFile(pipe, &character, 1, &read, nullptr) && read == 1) {
    if (character == '\n') return true;
    if (character != '\r') line.push_back(character);
  }
  return !line.empty();
}

std::string requestId(const std::string& json) {
  const std::string marker = "\"requestId\"";
  const size_t markerAt = json.find(marker);
  if (markerAt == std::string::npos) return "";
  const size_t quoteAt = json.find('"', json.find(':', markerAt) + 1);
  if (quoteAt == std::string::npos) return "";
  const size_t end = json.find('"', quoteAt + 1);
  return end == std::string::npos ? "" : json.substr(quoteAt + 1, end - quoteAt - 1);
}

void pumpChildStdout(HANDLE source, HANDLE control, std::mutex& lock, std::atomic<bool>& connected) {
  std::string buffer;
  char chunk[4096];
  DWORD read = 0;
  while (ReadFile(source, chunk, sizeof(chunk), &read, nullptr) && read != 0) {
    buffer.append(chunk, read);
    size_t newline = 0;
    while ((newline = buffer.find('\n')) != std::string::npos) {
      std::string line = buffer.substr(0, newline);
      buffer.erase(0, newline + 1);
      if (line.rfind(kControlPrefix, 0) == 0 && connected.load()) {
        writePipe(control, line.substr(sizeof(kControlPrefix) - 1) + "\n", lock);
      }
    }
  }
}

void pumpChildStderr(HANDLE source) {
  HANDLE destination = GetStdHandle(STD_ERROR_HANDLE);
  char chunk[4096];
  DWORD read = 0;
  DWORD written = 0;
  while (ReadFile(source, chunk, sizeof(chunk), &read, nullptr) && read != 0) {
    if (destination != nullptr && destination != INVALID_HANDLE_VALUE) {
      WriteFile(destination, chunk, read, &written, nullptr);
    }
  }
}

// Profile activation uses the same durable Windows primitive as the signed
// supervisor. Keeping this seam here makes locked-file behavior testable with
// a native MSVC build instead of silently falling back to shell commands.
[[maybe_unused]] bool durableMove(const std::wstring& from, const std::wstring& to) {
  return MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  const std::wstring node = argument(argc, argv, L"--node");
  const std::wstring wrapper = argument(argc, argv, L"--wrapper");
  const std::wstring launchId = argument(argc, argv, L"--launch-id");
  const std::wstring pipeName = argument(argc, argv, L"--pipe");
  const std::wstring cwd = argument(argc, argv, L"--cwd");
  const DWORD parentPid = static_cast<DWORD>(_wtoi(argument(argc, argv, L"--parent-pid").c_str()));
  if (node.empty() || wrapper.empty() || launchId.empty() || pipeName.empty() || parentPid == 0) {
    std::fwprintf(stderr, L"runtime-supervisor: missing required argument\n");
    return 2;
  }

  SECURITY_ATTRIBUTES security{};
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!currentUserSecurity(security, descriptor)) {
    std::fwprintf(stderr, L"runtime-supervisor: current-user pipe ACL failed\n");
    return 3;
  }
  HANDLE control = CreateNamedPipeW(
      pipeName.c_str(), PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 16384, 16384, 0, &security);
  LocalFree(descriptor);
  if (control == INVALID_HANDLE_VALUE) {
    std::fwprintf(stderr, L"runtime-supervisor: CreateNamedPipeW failed (%lu)\n", GetLastError());
    return 4;
  }

  HANDLE stdinRead = nullptr;
  HANDLE stdinWrite = nullptr;
  HANDLE stdoutRead = nullptr;
  HANDLE stdoutWrite = nullptr;
  HANDLE stderrRead = nullptr;
  HANDLE stderrWrite = nullptr;
  SECURITY_ATTRIBUTES inherited{};
  inherited.nLength = sizeof(inherited);
  inherited.bInheritHandle = TRUE;
  if (!CreatePipe(&stdinRead, &stdinWrite, &inherited, 0) ||
      !CreatePipe(&stdoutRead, &stdoutWrite, &inherited, 0) ||
      !CreatePipe(&stderrRead, &stderrWrite, &inherited, 0)) {
    std::fwprintf(stderr, L"runtime-supervisor: child pipe creation failed\n");
    CloseHandle(control);
    return 5;
  }
  SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0);

  const std::wstring command = quoteArgument(node) + L" " + quoteArgument(wrapper) + L" " +
      quoteArgument(launchId) + L" --windows-supervisor";
  std::vector<wchar_t> commandLine(command.begin(), command.end());
  commandLine.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = stdinRead;
  startup.hStdOutput = stdoutWrite;
  startup.hStdError = stderrWrite;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(node.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
                      CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, nullptr,
                      cwd.empty() ? nullptr : cwd.c_str(), &startup, &process)) {
    std::fwprintf(stderr, L"runtime-supervisor: CreateProcessW failed (%lu)\n", GetLastError());
    CloseHandle(control); CloseHandle(stdinRead); CloseHandle(stdinWrite);
    CloseHandle(stdoutRead); CloseHandle(stdoutWrite); CloseHandle(stderrRead); CloseHandle(stderrWrite);
    return 6;
  }
  CloseHandle(process.hThread);
  CloseHandle(stdinRead);
  CloseHandle(stdoutWrite);
  CloseHandle(stderrWrite);

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hProcess);
    CloseHandle(control); CloseHandle(stdinWrite); CloseHandle(stdoutRead); CloseHandle(stderrRead);
    return 7;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !AssignProcessToJobObject(job, process.hProcess)) {
    TerminateJobObject(job, 1);
    CloseHandle(job); CloseHandle(process.hProcess);
    CloseHandle(control); CloseHandle(stdinWrite); CloseHandle(stdoutRead); CloseHandle(stderrRead);
    return 8;
  }

  HANDLE watcherJob = nullptr;
  DuplicateHandle(GetCurrentProcess(), job, GetCurrentProcess(), &watcherJob, 0, FALSE, DUPLICATE_SAME_ACCESS);
  std::thread([parentPid, watcherJob] {
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
    const bool parentDied = parent == nullptr || WaitForSingleObject(parent, INFINITE) == WAIT_OBJECT_0;
    if (parentDied) {
      if (watcherJob != nullptr) TerminateJobObject(watcherJob, 0xC000013A);
      ExitProcess(1);
    }
    if (parent != nullptr) CloseHandle(parent);
    if (watcherJob != nullptr) CloseHandle(watcherJob);
  }).detach();

  std::atomic<bool> pipeConnected{false};
  std::thread connector([&] {
    const BOOL connected = ConnectNamedPipe(control, nullptr);
    pipeConnected.store(connected != FALSE || GetLastError() == ERROR_PIPE_CONNECTED);
  });
  while (!pipeConnected.load()) {
    if (WaitForSingleObject(process.hProcess, 100) == WAIT_OBJECT_0) {
      TerminateJobObject(job, 1);
      DisconnectNamedPipe(control);
      connector.join();
      CloseHandle(control); CloseHandle(stdinWrite); CloseHandle(job);
      CloseHandle(process.hProcess); CloseHandle(stdoutRead); CloseHandle(stderrRead);
      return 1;
    }
  }
  connector.join();
  std::atomic<bool> connected{true};
  std::atomic<bool> shutdownRequested{false};
  std::string shutdownRequest;
  std::chrono::steady_clock::time_point shutdownAt;
  std::mutex controlLock;
  std::mutex stateLock;
  std::thread stdoutPump(pumpChildStdout, stdoutRead, control, std::ref(controlLock), std::ref(connected));
  std::thread stderrPump(pumpChildStderr, stderrRead);
  std::thread controlReader([&] {
    std::string line;
    while (connected.load() && readLine(control, line)) {
      if (line.find("\"type\":\"shutdown\"") == std::string::npos) continue;
      const std::string id = requestId(line);
      if (id.empty()) continue;
      if (!shutdownRequested.exchange(true)) {
        {
          std::lock_guard<std::mutex> guard(stateLock);
          shutdownRequest = id;
          shutdownAt = std::chrono::steady_clock::now();
        }
        writePipe(control, "{\"type\":\"accepted\",\"requestId\":\"" + id + "\"}\n", controlLock);
        const std::string forwarded = line + "\n";
        DWORD written = 0;
        WriteFile(stdinWrite, forwarded.data(), static_cast<DWORD>(forwarded.size()), &written, nullptr);
      } else {
        std::string acceptedId;
        {
          std::lock_guard<std::mutex> guard(stateLock);
          acceptedId = shutdownRequest;
        }
        if (id == acceptedId) {
          writePipe(control, "{\"type\":\"accepted\",\"requestId\":\"" + id + "\"}\n", controlLock);
        }
      }
    }
    connected.store(false);
  });

  bool forced = false;
  while (WaitForSingleObject(process.hProcess, 100) != WAIT_OBJECT_0) {
    if (shutdownRequested.load()) {
      std::string request;
      std::chrono::steady_clock::time_point requestedAt;
      {
        std::lock_guard<std::mutex> guard(stateLock);
        request = shutdownRequest;
        requestedAt = shutdownAt;
      }
      if (std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - requestedAt).count() > kShutdownGraceMs) {
        writePipe(control, "{\"type\":\"timeout\",\"requestId\":\"" + request + "\"}\n", controlLock);
        TerminateJobObject(job, 1);
        writePipe(control, "{\"type\":\"forced\",\"requestId\":\"" + request + "\"}\n", controlLock);
        forced = true;
        break;
      }
    }
  }

  DWORD exitCode = 1;
  GetExitCodeProcess(process.hProcess, &exitCode);
  if (!forced) {
    std::string request;
    {
      std::lock_guard<std::mutex> guard(stateLock);
      request = shutdownRequest;
    }
    const std::string id = request.empty() ? launchId : request;
    writePipe(control, "{\"type\":\"exited\",\"requestId\":\"" + id +
        "\",\"code\":" + std::to_string(exitCode) + ",\"signal\":null}\n", controlLock);
  }
  connected.store(false);
  DisconnectNamedPipe(control);
  if (controlReader.joinable()) controlReader.join();
  if (stdoutPump.joinable()) stdoutPump.join();
  if (stderrPump.joinable()) stderrPump.join();
  CloseHandle(control);
  CloseHandle(stdinWrite);
  CloseHandle(job);
  CloseHandle(process.hProcess);
  CloseHandle(stdoutRead);
  CloseHandle(stderrRead);
  return forced ? 1 : static_cast<int>(exitCode);
}
