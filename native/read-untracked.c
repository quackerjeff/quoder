#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

enum {
  EXIT_UNSAFE = 20,
  EXIT_TOO_LARGE = 21,
  EXIT_IO = 22,
};

static int write_all(int fd, const unsigned char *data, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    const ssize_t written = write(fd, data + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    offset += (size_t)written;
  }
  return 0;
}

static int valid_relative_path(const char *path) {
  if (path == NULL || path[0] == '\0' || path[0] == '/') return 0;
  const size_t length = strlen(path);
  if (length > 4096 || path[length - 1] == '/') return 0;

  const char *component = path;
  for (const char *cursor = path;; cursor++) {
    if (*cursor != '/' && *cursor != '\0') continue;
    const size_t component_length = (size_t)(cursor - component);
    if (component_length == 0 || (component_length == 1 && component[0] == '.') ||
        (component_length == 2 && component[0] == '.' && component[1] == '.')) {
      return 0;
    }
    if (*cursor == '\0') break;
    component = cursor + 1;
  }
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 3 || !valid_relative_path(argv[1])) return EXIT_UNSAFE;

  char *end = NULL;
  errno = 0;
  const unsigned long long parsed_limit = strtoull(argv[2], &end, 10);
  if (errno != 0 || end == argv[2] || *end != '\0' || parsed_limit == 0 || parsed_limit > 262144) {
    return EXIT_UNSAFE;
  }
  const size_t limit = (size_t)parsed_limit;

  struct stat root_stat;
  if (fstat(3, &root_stat) != 0 || !S_ISDIR(root_stat.st_mode)) return EXIT_UNSAFE;

  char *path = strdup(argv[1]);
  if (path == NULL) return EXIT_IO;

  int current_fd = 3;
  int owns_current_fd = 0;
  char *component = path;
  int file_fd = -1;
  for (;;) {
    char *slash = strchr(component, '/');
    if (slash != NULL) *slash = '\0';
    const int is_leaf = slash == NULL;
    int flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW;
    if (is_leaf) flags |= O_NONBLOCK;
    else flags |= O_DIRECTORY;

    const int next_fd = openat(current_fd, component, flags);
    if (owns_current_fd) close(current_fd);
    if (next_fd < 0) {
      free(path);
      return EXIT_UNSAFE;
    }
    if (is_leaf) {
      file_fd = next_fd;
      break;
    }
    current_fd = next_fd;
    owns_current_fd = 1;
    component = slash + 1;
  }
  if (owns_current_fd) close(current_fd);
  free(path);

  struct stat file_stat;
  if (fstat(file_fd, &file_stat) != 0 || !S_ISREG(file_stat.st_mode)) {
    close(file_fd);
    return EXIT_UNSAFE;
  }
  if (file_stat.st_size < 0 || (uintmax_t)file_stat.st_size > (uintmax_t)limit) {
    close(file_fd);
    return EXIT_TOO_LARGE;
  }

  unsigned char *buffer = malloc(limit + 1);
  if (buffer == NULL) {
    close(file_fd);
    return EXIT_IO;
  }

  size_t total = 0;
  while (total <= limit) {
    const ssize_t count = read(file_fd, buffer + total, limit + 1 - total);
    if (count < 0) {
      if (errno == EINTR) continue;
      free(buffer);
      close(file_fd);
      return EXIT_IO;
    }
    if (count == 0) break;
    total += (size_t)count;
  }
  close(file_fd);

  if (total > limit) {
    free(buffer);
    return EXIT_TOO_LARGE;
  }
  const int result = write_all(STDOUT_FILENO, buffer, total) == 0 ? 0 : EXIT_IO;
  free(buffer);
  return result;
}
