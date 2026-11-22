// Alocador do LVGL na PSRAM (LV_STDLIB_CUSTOM). Objetos, estilos, listas e cache de fontes do LVGL
// saem da RAM interna, que fica reservada para Wi-Fi, TLS, DMA e pilhas.
#include <Arduino.h>
#include <lvgl.h>
#include "esp_heap_caps.h"

extern "C" {
void lv_mem_init(void) {}
void lv_mem_deinit(void) {}
lv_mem_pool_t lv_mem_add_pool(void *, size_t) { return NULL; }
void lv_mem_remove_pool(lv_mem_pool_t) {}
// Híbrido: blocos pequenos (objetos, estilos) ficam na RAM interna enquanto houver folga (acesso rápido, sem disputar a PSRAM com o
// decodificador de áudio); o resto, e tudo quando a RAM interna estiver apertada, vai para a PSRAM.
static const size_t SMALL_MAX = 512, INTERNAL_RESERVE = 64 * 1024;
void *lv_malloc_core(size_t size) {
  if (size <= SMALL_MAX && heap_caps_get_free_size(MALLOC_CAP_INTERNAL) > INTERNAL_RESERVE) {
    void *p = heap_caps_malloc(size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT); if (p) return p;
  }
  void *p = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  return p ? p : heap_caps_malloc(size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}
void *lv_realloc_core(void *p, size_t size) {
  if (!p) return lv_malloc_core(size);
  void *n = lv_malloc_core(size); if (!n) return NULL;
  size_t old = heap_caps_get_allocated_size(p); memcpy(n, p, old < size ? old : size); heap_caps_free(p); return n;
}
void lv_free_core(void *p) { heap_caps_free(p); }
void lv_mem_monitor_core(lv_mem_monitor_t *) {}
lv_result_t lv_mem_test_core(void) { return LV_RESULT_OK; }
}
